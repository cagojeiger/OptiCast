//! Module sampling (`docs/web.md` §7): each module centre through the
//! homography, a 3×3 pixel mean there, compared with the mean of the
//! surrounding 7×7 modules (whitened data is half ones, so that mean sits
//! between the two colors). Blur spreads each module into its neighbours, so
//! the threshold may also move part of the way to the mean of the four
//! neighbours, which takes that back out (a lone 1 among 0s stays above it):
//! of [`SHIFTS`], the one that misreads the fewest of the layout's known modules.

use diodecam_core::{FormatInfo, Layout, ModuleGrid};

use crate::binarize::GrayImage;
use crate::geom::Homography;
use crate::timing::Correction;

/// Threshold window: (2R + 1)² modules.
const R: usize = 3;
/// Share of the way from the 7×7 mean to the neighbours' mean; ties keep the
/// first, so a sharp image is read as without the shift.
const SHIFTS: [f64; 3] = [0.0, 0.5, 0.75];

/// Reusable buffers.
#[derive(Default)]
pub struct Sampler {
    values: Vec<u32>,
    integral: Vec<u32>,
    /// The fixed modules (x, y, value) of the layout for `fixed_for`.
    fixed: Vec<(usize, usize, bool)>,
    fixed_for: Option<FormatInfo>,
}

impl Sampler {
    /// Samples the layout's grid. `bright`: module 1 (foreground) is the lighter color.
    pub fn sample(
        &mut self,
        img: &GrayImage,
        hom: &Homography,
        corr: Option<&Correction>,
        layout: &Layout,
        bright: bool,
    ) -> ModuleGrid {
        let (w, h) = (layout.width(), layout.height());
        self.values.clear();
        self.values.reserve(w * h);
        for y in 0..h {
            for x in 0..w {
                let (mx, my) = (x as f64 + 0.5, y as f64 + 0.5);
                let (mx, my) = corr.map_or((mx, my), |c| c.apply(mx, my));
                let p = hom.apply(mx, my);
                let v = if p.x.is_finite() && p.y.is_finite() { img.box3(p.x, p.y) } else { 0 };
                self.values.push(v);
            }
        }
        // Integral image of the module values.
        let iw = w + 1;
        self.integral.clear();
        self.integral.resize(iw * (h + 1), 0);
        for y in 0..h {
            let mut run = 0u32;
            for x in 0..w {
                run += self.values[y * w + x];
                self.integral[(y + 1) * iw + x + 1] = self.integral[y * iw + x + 1] + run;
            }
        }
        if self.fixed_for != Some(layout.format()) {
            self.fixed.clear();
            for y in 0..h {
                for x in 0..w {
                    if let Some(f) = layout.fixed(x, y) {
                        self.fixed.push((x, y, f));
                    }
                }
            }
            self.fixed_for = Some(layout.format());
        }
        let (values, integral) = (&self.values, &self.integral);
        let v = |x: usize, y: usize| values[y * w + x] as f64;
        // The 7×7-module mean around (x, y).
        let mean = |x: usize, y: usize| {
            let (x0, x1, y0, y1) = (x.saturating_sub(R), (x + R + 1).min(w), y.saturating_sub(R), (y + R + 1).min(h));
            let sum = integral[y1 * iw + x1] + integral[y0 * iw + x0] - integral[y0 * iw + x1] - integral[y1 * iw + x0];
            sum as f64 / ((x1 - x0) * (y1 - y0)) as f64
        };
        // The mean of the four neighbours inside the grid.
        let near = |x: usize, y: usize| {
            let neighbours = [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)];
            let (mut sum, mut n) = (0.0, 0.0);
            for (nx, ny) in neighbours.into_iter().filter(|&(nx, ny)| nx < w && ny < h) {
                sum += v(nx, ny);
                n += 1.0;
            }
            sum / n
        };
        // Misreads of the known modules under every shift, in one pass.
        let mut misreads = [0usize; SHIFTS.len()];
        for &(x, y, f) in &self.fixed {
            let (value, m, n) = (v(x, y), mean(x, y), near(x, y));
            for (count, s) in misreads.iter_mut().zip(SHIFTS) {
                *count += (((value > m + s * (n - m)) == bright) != f) as usize;
            }
        }
        let best = (1..SHIFTS.len()).fold(0, |b, k| if misreads[k] < misreads[b] { k } else { b });
        let shift = SHIFTS[best];
        let mut grid = ModuleGrid::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let m = mean(x, y);
                let threshold = if shift == 0.0 { m } else { m + shift * (near(x, y) - m) };
                grid.set(x, y, (v(x, y) > threshold) == bright);
            }
        }
        grid
    }
}
