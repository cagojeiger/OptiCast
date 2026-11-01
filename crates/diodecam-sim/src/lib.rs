//! Test-only simulator for the DiodeCam v2 receiver.
//!
//! 1. [`Terminal::rasterize`] draws a [`ModuleGrid`] the way a terminal shows the
//!    sender's output (spec §2.1): `ssh` cells are 8×16 px with `▀` covering the
//!    top half of the glyph box, `vt100` cells are a single module; an optional
//!    line gap at the bottom of each cell shows the cell background.
//! 2. [`Camera::shoot`] films that screen: projective warp (plus optional
//!    barrel distortion), bilinear sampling, black/white levels, integer box
//!    blur and Gaussian sensor noise.
//! 3. [`tear`] builds a torn capture: rows above a boundary from the newer frame.
//!
//! Everything is deterministic for a given seed.

#![forbid(unsafe_code)]

use diodecam_core::{ModuleGrid, Profile};

/// An 8-bit grayscale image, row-major.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gray {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl Gray {
    pub fn new(width: usize, height: usize, fill: u8) -> Gray {
        Gray { width, height, data: vec![fill; width * height] }
    }

    pub fn get(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.width + x]
    }

    /// Gray → RGBA (what a canvas `getImageData` returns).
    pub fn to_rgba(&self) -> Vec<u8> {
        self.data.iter().flat_map(|&g| [g, g, g, 255]).collect()
    }

    /// Binary PGM (P5), for looking at a failing test case.
    pub fn to_pgm(&self) -> Vec<u8> {
        let mut out = format!("P5\n{} {}\n255\n", self.width, self.height).into_bytes();
        out.extend_from_slice(&self.data);
        out
    }
}

/// Terminal colors as gray levels: module 1 is `fg`, module 0 is `bg`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub fg: u8,
    pub bg: u8,
}

impl Theme {
    /// Light text on a dark background.
    pub const DARK: Theme = Theme { fg: 220, bg: 24 };
    /// Dark text on a light background: module 1 is the darker color.
    pub const LIGHT: Theme = Theme { fg: 30, bg: 235 };
}

/// How the terminal draws its cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terminal {
    pub cols: usize,
    pub rows: usize,
    pub profile: Profile,
    pub theme: Theme,
    pub cell_width: usize,
    pub cell_height: usize,
    /// Pixel rows at the bottom of each cell that glyphs do not reach (they show
    /// the cell background). `▀` then covers the top half of the remaining glyph box.
    pub line_gap: usize,
    /// Background-colored margin around the cell area, in pixels.
    pub padding: usize,
}

impl Terminal {
    /// An `ssh`-profile terminal with 8×16 px cells, dark theme, no line gap.
    pub fn new(cols: usize, rows: usize) -> Terminal {
        Terminal {
            cols,
            rows,
            profile: Profile::Ssh,
            theme: Theme::DARK,
            cell_width: 8,
            cell_height: 16,
            line_gap: 0,
            padding: 6,
        }
    }

    pub fn pixel_size(&self) -> (usize, usize) {
        (self.cols * self.cell_width + 2 * self.padding, self.rows * self.cell_height + 2 * self.padding)
    }

    /// The screen showing `grid` from the top-left cell, the last column blank,
    /// and two status rows of text-like blobs below the grid.
    pub fn rasterize(&self, grid: &ModuleGrid) -> Gray {
        let (width, height) = self.pixel_size();
        let Theme { fg, bg } = self.theme;
        let mut img = Gray::new(width, height, bg);
        let (cw, ch) = (self.cell_width, self.cell_height);
        let glyph_box = ch.saturating_sub(self.line_gap);
        let half = glyph_box / 2;
        let level = |v: bool| if v { fg } else { bg };
        let per_cell = self.profile.modules_per_cell();
        let grid_rows = (grid.height() / per_cell).min(self.rows);
        for row in 0..grid_rows {
            for col in 0..grid.width().min(self.cols.saturating_sub(1)) {
                let (top, bottom) = match self.profile {
                    Profile::Ssh => (grid.get(col, 2 * row), grid.get(col, 2 * row + 1)),
                    Profile::Vt100 => (grid.get(col, row), grid.get(col, row)),
                };
                // The cell background carries the bottom module; '▀' (only when the
                // two differ) paints the top half of the glyph box with the top module.
                let x0 = self.padding + col * cw;
                let y0 = self.padding + row * ch;
                for py in 0..ch {
                    let v = if top != bottom && py < half { level(top) } else { level(bottom) };
                    let start = (y0 + py) * width + x0;
                    img.data[start..start + cw].fill(v);
                }
            }
        }
        // Status rows: pseudo-text, a blob of ink in most cells.
        let mut rng = Rng::new(0x5747_4154);
        for row in self.rows.saturating_sub(2)..self.rows {
            for col in 0..self.cols.saturating_sub(1) {
                if rng.next_u64() % 5 == 0 {
                    continue;
                }
                let x0 = self.padding + col * cw;
                let y0 = self.padding + row * ch;
                for py in ch / 4..ch * 3 / 4 {
                    let start = (y0 + py) * width + x0 + 1;
                    img.data[start..start + cw * 6 / 10].fill(fg);
                }
            }
        }
        img
    }
}

pub type Point = (f64, f64);

/// A 3×3 projective map, row-major, applied to (x, y, 1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Homography(pub [f64; 9]);

impl Homography {
    pub fn apply(&self, x: f64, y: f64) -> Point {
        let h = &self.0;
        let w = h[6] * x + h[7] * y + h[8];
        ((h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w)
    }

    /// The map taking the four `from` points onto the four `to` points.
    pub fn from_points(from: [Point; 4], to: [Point; 4]) -> Homography {
        let mut a = [[0.0f64; 9]; 8];
        for i in 0..4 {
            let (x, y) = from[i];
            let (u, v) = to[i];
            a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u, u];
            a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v, v];
        }
        for col in 0..8 {
            let pivot = (col..8).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs())).unwrap();
            a.swap(col, pivot);
            let pivot_row = a[col];
            for (r, row) in a.iter_mut().enumerate() {
                if r != col {
                    let f = row[col] / pivot_row[col];
                    for (v, p) in row.iter_mut().zip(pivot_row).skip(col) {
                        *v -= f * p;
                    }
                }
            }
        }
        let mut h = [1.0; 9];
        for i in 0..8 {
            h[i] = a[i][8] / a[i][i];
        }
        Homography(h)
    }
}

/// Where a screen of aspect `aspect` (width / height) lands in a `width`×`height`
/// camera frame when it fills `fill` of the frame and the camera is turned by
/// `yaw` (about the vertical axis), `pitch` and `roll` degrees: a pinhole
/// projection with a ~70° horizontal field of view. Corners are TL, TR, BR, BL.
pub fn view(width: usize, height: usize, aspect: f64, fill: f64, yaw: f64, pitch: f64, roll: f64) -> [Point; 4] {
    let (w, h) = (width as f64, height as f64);
    let focal = w / (2.0 * (35f64).to_radians().tan());
    // Screen half-extents at distance 1 so that it fills `fill` of the frame when seen head-on.
    let mut sw = fill * w / focal / 2.0;
    let mut sh = sw / aspect;
    if sh > fill * h / focal / 2.0 {
        sh = fill * h / focal / 2.0;
        sw = sh * aspect;
    }
    let (cy, sy) = (yaw.to_radians().cos(), yaw.to_radians().sin());
    let (cp, sp) = (pitch.to_radians().cos(), pitch.to_radians().sin());
    let (cr, sr) = (roll.to_radians().cos(), roll.to_radians().sin());
    let project = |x: f64, y: f64| {
        // Rotate the screen plane about its centre, then push it to depth 1.
        let (x1, z1) = (x * cy, -x * sy);
        let (y2, z2) = (y * cp - z1 * sp, y * sp + z1 * cp);
        let (x3, y3) = (x1 * cr - y2 * sr, x1 * sr + y2 * cr);
        let z = 1.0 + z2;
        (w / 2.0 + focal * x3 / z, h / 2.0 + focal * y3 / z)
    };
    [project(-sw, -sh), project(sw, -sh), project(sw, sh), project(-sw, sh)]
}

/// A simulated phone camera.
#[derive(Clone, Debug, PartialEq)]
pub struct Camera {
    pub width: usize,
    pub height: usize,
    /// Where the screen image's TL, TR, BR, BL corners land.
    pub corners: [Point; 4],
    /// Output levels for screen gray 0 and 255 (glare lifts black, exposure dims white).
    pub levels: (f64, f64),
    /// Box-blur radius in pixels (applied twice: horizontally then vertically).
    pub blur: usize,
    /// Gaussian noise sigma in gray levels.
    pub noise: f64,
    /// Barrel distortion k₁ on the normalized radius (0 = none).
    pub radial: f64,
    /// Gray level outside the screen.
    pub surround: u8,
    pub seed: u64,
}

impl Camera {
    pub fn new(width: usize, height: usize, corners: [Point; 4]) -> Camera {
        Camera { width, height, corners, levels: (0.0, 255.0), blur: 0, noise: 0.0, radial: 0.0, surround: 30, seed: 1 }
    }

    pub fn shoot(&self, screen: &Gray) -> Gray {
        let (w, h) = (self.width, self.height);
        let (sw, sh) = (screen.width as f64, screen.height as f64);
        // Inverse warp: camera pixel → screen position.
        let inv = Homography::from_points(self.corners, [(0.0, 0.0), (sw, 0.0), (sw, sh), (0.0, sh)]);
        let (lo, hi) = self.levels;
        let scale = (hi - lo) / 255.0;
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        let norm = 1.0 / (cx * cx + cy * cy);
        let mut out = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let (mut px, mut py) = (x as f64 + 0.5, y as f64 + 0.5);
                if self.radial != 0.0 {
                    let (dx, dy) = (px - cx, py - cy);
                    let f = 1.0 + self.radial * (dx * dx + dy * dy) * norm;
                    px = cx + dx * f;
                    py = cy + dy * f;
                }
                let (u, v) = inv.apply(px, py);
                // Pixel centres sit at +0.5 in screen space.
                let (u, v) = (u - 0.5, v - 0.5);
                out[y * w + x] = if u >= 0.0 && v >= 0.0 && u < sw - 1.0 && v < sh - 1.0 {
                    (lo + bilinear(screen, u, v) * scale) as f32
                } else {
                    self.surround as f32
                };
            }
        }
        if self.blur > 0 {
            box_blur(&mut out, w, h, self.blur);
        }
        let mut rng = Rng::new(self.seed);
        let data = out
            .iter()
            .map(|&v| {
                let n = if self.noise > 0.0 { rng.gaussian() * self.noise } else { 0.0 };
                (v as f64 + n).round().clamp(0.0, 255.0) as u8
            })
            .collect();
        Gray { width: w, height: h, data }
    }
}

/// A capture taken while the screen was being redrawn: rows `0..boundary` show
/// `newer`, the rest `older`. Both must have the same size.
pub fn tear(newer: &Gray, older: &Gray, boundary: usize) -> Gray {
    assert_eq!((newer.width, newer.height), (older.width, older.height));
    let split = boundary.min(newer.height) * newer.width;
    let mut data = older.data.clone();
    data[..split].copy_from_slice(&newer.data[..split]);
    Gray { width: newer.width, height: newer.height, data }
}

fn bilinear(img: &Gray, u: f64, v: f64) -> f64 {
    let (x, y) = (u.floor() as usize, v.floor() as usize);
    let (fx, fy) = (u - x as f64, v - y as f64);
    let i = y * img.width + x;
    let d = &img.data;
    let top = d[i] as f64 * (1.0 - fx) + d[i + 1] as f64 * fx;
    let bottom = d[i + img.width] as f64 * (1.0 - fx) + d[i + img.width + 1] as f64 * fx;
    top * (1.0 - fy) + bottom * fy
}

/// Separable box blur of radius `r`, averaging only pixels inside the image.
fn box_blur(img: &mut [f32], w: usize, h: usize, r: usize) {
    let mut line = Vec::new();
    let mut blur_line = |values: &mut dyn Iterator<Item = f32>, len: usize, out: &mut Vec<f32>| {
        line.clear();
        line.extend(values);
        let mut prefix = vec![0f32; len + 1];
        for i in 0..len {
            prefix[i + 1] = prefix[i] + line[i];
        }
        out.clear();
        for i in 0..len {
            let (a, b) = (i.saturating_sub(r), (i + r + 1).min(len));
            out.push((prefix[b] - prefix[a]) / (b - a) as f32);
        }
    };
    let mut out = Vec::new();
    for y in 0..h {
        blur_line(&mut img[y * w..(y + 1) * w].iter().copied(), w, &mut out);
        img[y * w..(y + 1) * w].copy_from_slice(&out);
    }
    for x in 0..w {
        blur_line(&mut (0..h).map(|y| img[y * w + x]), h, &mut out);
        for (y, &v) in out.iter().enumerate() {
            img[y * w + x] = v;
        }
    }
}

/// splitmix64.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in (0, 1).
    pub fn uniform(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }

    pub fn gaussian(&mut self) -> f64 {
        (-2.0 * self.uniform().ln()).sqrt() * (2.0 * std::f64::consts::PI * self.uniform()).cos()
    }

    pub fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next_u64() as u8).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use diodecam_core::{frame, Layout, SendOptions, Transfer};

    fn grid(cols: usize, rows: usize, profile: Profile) -> (Layout, ModuleGrid) {
        let layout = Layout::for_terminal(profile, cols, rows).unwrap();
        let mut tx = Transfer::prepare(&Rng::new(1).bytes(5000), "f", SendOptions::default(), 0).unwrap();
        let g = frame::render(&layout, &tx.next_frame(&layout));
        (layout, g)
    }

    #[test]
    fn ssh_cells_show_both_modules() {
        let (layout, g) = grid(80, 24, Profile::Ssh);
        for theme in [Theme::DARK, Theme::LIGHT] {
            for gap in [0, 3] {
                let term = Terminal { theme, line_gap: gap, ..Terminal::new(80, 24) };
                let img = term.rasterize(&g);
                assert_eq!((img.width, img.height), term.pixel_size());
                for y in 0..layout.height() {
                    for x in 0..layout.width() {
                        // Sample each module at the middle of its part of the cell.
                        let py = term.padding + (y / 2) * 16 + if y % 2 == 0 { 3 } else { 12 };
                        let px = term.padding + x * 8 + 4;
                        let want = if g.get(x, y) { theme.fg } else { theme.bg };
                        assert_eq!(img.get(px, py), want, "({x},{y}) gap {gap}");
                    }
                }
            }
        }
    }

    #[test]
    fn vt100_cells_are_one_module() {
        let (layout, g) = grid(120, 40, Profile::Vt100);
        let term = Terminal { profile: Profile::Vt100, ..Terminal::new(120, 40) };
        let img = term.rasterize(&g);
        for y in 0..layout.height() {
            for x in 0..layout.width() {
                let v = img.get(term.padding + x * 8 + 4, term.padding + y * 16 + 8);
                assert_eq!(v == Theme::DARK.fg, g.get(x, y));
            }
        }
    }

    #[test]
    fn identity_camera_reproduces_the_screen() {
        let (_, g) = grid(80, 24, Profile::Ssh);
        let screen = Terminal::new(80, 24).rasterize(&g);
        let (w, h) = (screen.width as f64, screen.height as f64);
        let cam = Camera::new(screen.width, screen.height, [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]);
        let shot = cam.shoot(&screen);
        let inner = |img: &Gray| -> Vec<u8> {
            (1..img.height - 1)
                .flat_map(|y| (1..img.width - 1).map(move |x| (x, y)))
                .map(|(x, y)| img.get(x, y))
                .collect()
        };
        assert_eq!(inner(&shot), inner(&screen));
    }

    #[test]
    fn homography_maps_corners() {
        let from = [(0.0, 0.0), (10.0, 0.0), (10.0, 5.0), (0.0, 5.0)];
        let to = [(3.0, 4.0), (40.0, 6.0), (38.0, 30.0), (1.0, 25.0)];
        let h = Homography::from_points(from, to);
        for i in 0..4 {
            let (x, y) = h.apply(from[i].0, from[i].1);
            assert!((x - to[i].0).abs() < 1e-9 && (y - to[i].1).abs() < 1e-9);
        }
    }

    #[test]
    fn tear_takes_top_rows_from_the_newer_frame() {
        let a = Gray::new(4, 4, 1);
        let b = Gray::new(4, 4, 2);
        let t = tear(&a, &b, 1);
        assert_eq!(t.data, [1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    }

    #[test]
    fn view_head_on_is_centred() {
        let c = view(1920, 1080, 16.0 / 9.0, 0.8, 0.0, 0.0, 0.0);
        assert!((c[0].0 - 192.0).abs() < 1e-6 && (c[2].0 - 1728.0).abs() < 1e-6);
        assert!((c[0].1 - 108.0).abs() < 1e-6 && (c[2].1 - 972.0).abs() < 1e-6);
        // Turning the camera makes one side shorter than the other.
        let t = view(1920, 1080, 16.0 / 9.0, 0.8, 15.0, 0.0, 0.0);
        let left = t[3].1 - t[0].1;
        let right = t[2].1 - t[1].1;
        assert!((left / right - 1.0).abs() > 0.1, "{left} vs {right}");
    }
}
