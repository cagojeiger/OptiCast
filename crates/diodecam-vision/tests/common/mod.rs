//! Shared scenario code for the vision tests: a real sender frame → simulated
//! terminal → simulated camera → `Vision::process` → tiles, compared with the truth.

#![allow(dead_code)]

use diodecam_core::tile::{self, Tile};
use diodecam_core::{frame, Layout, ModuleGrid, Profile, SendOptions, Transfer};
use diodecam_sim::{tear, view, Camera, Gray, Rng, Terminal, Theme};
use diodecam_vision::{Detection, Vision};

#[derive(Clone, Copy, Debug)]
pub struct Case {
    pub cols: usize,
    pub rows: usize,
    pub profile: Profile,
    pub theme: Theme,
    pub line_gap: usize,
    pub camera: (usize, usize),
    pub fill: f64,
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    pub blur: usize,
    pub noise: f64,
    pub levels: (f64, f64),
    pub radial: f64,
    /// Gray level around the screen (bezel, desk).
    pub surround: u8,
    pub seed: u64,
}

impl Default for Case {
    fn default() -> Case {
        Case {
            cols: 200,
            rows: 55,
            profile: Profile::Ssh,
            theme: Theme::DARK,
            line_gap: 0,
            camera: (1920, 1080),
            fill: 0.85,
            yaw: 0.0,
            pitch: 0.0,
            roll: 0.0,
            blur: 0,
            noise: 0.0,
            levels: (0.0, 255.0),
            radial: 0.0,
            surround: 30,
            seed: 1,
        }
    }
}

/// A transfer drawn frame by frame for one terminal size.
pub struct Sender {
    pub layout: Layout,
    pub transfer: Transfer,
}

impl Sender {
    pub fn new(case: &Case, bytes: usize) -> Sender {
        let layout = Layout::for_terminal(case.profile, case.cols, case.rows).unwrap();
        let data = Rng::new(case.seed ^ 0xF11E).bytes(bytes);
        let transfer = Transfer::prepare(&data, "test.bin", SendOptions { compress: false }, 12_345).unwrap();
        Sender { layout, transfer }
    }

    /// The next frame's grid and the tiles in it.
    pub fn next(&mut self) -> (ModuleGrid, Vec<Tile>) {
        let tiles = self.transfer.next_frame_tiles(self.layout.tiles());
        let cws: Vec<_> = tiles.iter().map(Tile::encode).collect();
        (frame::render(&self.layout, &cws), tiles)
    }
}

pub fn terminal(case: &Case) -> Terminal {
    Terminal {
        profile: case.profile,
        theme: case.theme,
        line_gap: case.line_gap,
        ..Terminal::new(case.cols, case.rows)
    }
}

pub fn camera(case: &Case, screen: &Gray, seed: u64) -> Camera {
    let (w, h) = case.camera;
    let aspect = screen.width as f64 / screen.height as f64;
    let corners = view(w, h, aspect, case.fill, case.yaw, case.pitch, case.roll);
    Camera {
        blur: case.blur,
        noise: case.noise,
        levels: case.levels,
        radial: case.radial,
        surround: case.surround,
        seed,
        ..Camera::new(w, h, corners)
    }
}

/// Result of one camera frame.
#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub detected: bool,
    pub format_ok: bool,
    pub tracked: bool,
    pub residual: f64,
    pub module_errors: usize,
    pub modules: usize,
    pub tiles_ok: usize,
    pub tiles: usize,
    /// Tiles that decoded but are not what was sent at that position: must stay 0.
    pub wrong: usize,
    /// Correct tiles per frame in `sent` order (for torn captures).
    pub ok_by_frame: Vec<usize>,
    pub corrected: bool,
}

/// Compares a detection with the frame (or frames, for a torn capture) on screen.
/// `truth` is the grid used for the module error count; tiles may come from any
/// of the `sent` frames at the same position.
pub fn score(det: Option<&Detection>, layout: &Layout, truth: &ModuleGrid, sent: &[&[Tile]]) -> Outcome {
    let mut out = Outcome { tiles: layout.tiles(), ok_by_frame: vec![0; sent.len()], ..Outcome::default() };
    let Some(d) = det else { return out };
    out.detected = true;
    out.tracked = d.tracked;
    out.residual = d.residual;
    out.corrected = d.corrected;
    out.format_ok = d.format == layout.format();
    if !out.format_ok {
        return out;
    }
    out.modules = truth.width() * truth.height();
    for y in 0..truth.height() {
        for x in 0..truth.width() {
            if d.grid.get(x, y) != truth.get(x, y) {
                out.module_errors += 1;
            }
        }
    }
    for (n, raw) in frame::read_tiles(layout, &d.grid).iter().enumerate() {
        if let Ok(t) = tile::decode(raw, n) {
            match sent.iter().position(|frame| frame[n] == t) {
                Some(f) => {
                    out.tiles_ok += 1;
                    out.ok_by_frame[f] += 1;
                }
                None => out.wrong += 1,
            }
        }
    }
    out
}

/// Films `frames` consecutive sender frames with fresh noise each, through one
/// `Vision` (so later frames use tracking).
pub fn film(case: &Case, frames: usize) -> Vec<Outcome> {
    let mut sender = Sender::new(case, 200_000);
    let term = terminal(case);
    let mut vision = Vision::new();
    (0..frames)
        .map(|i| {
            let (grid, tiles) = sender.next();
            let screen = term.rasterize(&grid);
            let shot = camera(case, &screen, case.seed * 1000 + i as u64).shoot(&screen);
            let det = vision.process(&shot.data, shot.width, shot.height);
            score(det.as_ref(), &sender.layout, &grid, &[&tiles])
        })
        .collect()
}

/// Films a torn capture: the top `fraction` of the screen shows the next frame.
/// `sent` in the outcome is [older, newer].
pub fn film_torn(case: &Case, fraction: f64) -> (Outcome, usize) {
    let mut sender = Sender::new(case, 200_000);
    for _ in 0..case.seed % 7 {
        sender.next();
    }
    let term = terminal(case);
    let (g0, t0) = sender.next();
    let (g1, t1) = sender.next();
    let (s0, s1) = (term.rasterize(&g0), term.rasterize(&g1));
    let boundary = (s0.height as f64 * fraction) as usize;
    let screen = tear(&s1, &s0, boundary);
    let shot = camera(case, &screen, case.seed).shoot(&screen);
    let det = Vision::new().process(&shot.data, shot.width, shot.height);
    // Module errors against the older frame are meaningless here; count tiles only.
    let out = score(det.as_ref(), &sender.layout, &g0, &[&t0, &t1]);
    (out, boundary)
}

/// (module error rate, tile pass rate, wrong tiles, frames whose FI decoded).
pub fn summary(outcomes: &[Outcome]) -> (f64, f64, usize, usize) {
    let modules: usize = outcomes.iter().map(|o| o.modules).sum();
    let errors: usize = outcomes.iter().map(|o| o.module_errors).sum();
    let tiles: usize = outcomes.iter().map(|o| o.tiles).sum();
    let ok: usize = outcomes.iter().map(|o| o.tiles_ok).sum();
    let wrong: usize = outcomes.iter().map(|o| o.wrong).sum();
    let detected = outcomes.iter().filter(|o| o.format_ok).count();
    (errors as f64 / modules.max(1) as f64, ok as f64 / tiles.max(1) as f64, wrong, detected)
}
