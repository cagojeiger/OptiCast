//! DiodeCam receiver vision (`docs/web.md` §7): finds the module grid
//! of a frame (spec §2) in a grayscale camera image and samples
//! it into an [`diodecam_core::ModuleGrid`].
//!
//! Pipeline for one frame ([`Vision::process`]):
//! 1. Local-mean binarization (integral image) and a run-length search for the
//!    three big finders in both polarities, cross-checked vertically,
//!    horizontally and diagonally. TL is the right-angle corner, TR/BL follow
//!    from the cross product, and the finders' color gives the polarity.
//! 2. The top (y = 5) and left (x = 5) timing lines between the finder centres:
//!    their edges give W and H by counting and the projective module spacing
//!    along both lines, which fixes a first homography. When blur merges the
//!    edges, the phase of the alternation along the line gives the same.
//! 3. Format information: top copy (rows 2–3), else the bottom copy.
//! 4. The small bottom-right finder near its predicted position, and the
//!    4-point homography TL(5.5, 5.5), TR(W − 5.5, 5.5), BR(W − 4.5, H − 4.5),
//!    BL(5.5, H − 5.5).
//! 5. Residual check on all four timing lines (the phase of their alternation,
//!    window by window); above 0.1 module the measured offsets are blended in
//!    as a correction (lens distortion, finder centres off under blur).
//! 6. 3×3-mean sampling of every module against a 7×7-module local mean,
//!    shifted towards the neighbours' mean when blur spreads modules.
//!
//! The next frame first looks for the finders near their last positions
//! (tracking) and falls back to the full search.

#![forbid(unsafe_code)]

mod binarize;
mod finder;
mod geom;
mod sample;
mod timing;

pub use geom::{Homography, Point};

use binarize::{Binarizer, Bitmap, GrayImage, Rect};
use diodecam_core::layout::{fi_bottom_position, fi_top_position, FI_BITS};
use diodecam_core::{FormatInfo, Layout, ModuleGrid};
use finder::{Candidate, Triple};
use sample::Sampler;
use timing::{Correction, Line};

/// Y = (77R + 150G + 29B) >> 8 for every pixel of an RGBA buffer.
pub fn luma_rgba(rgba: &[u8], out: &mut Vec<u8>) {
    out.clear();
    out.extend(rgba.chunks_exact(4).map(|p| ((77 * p[0] as u32 + 150 * p[1] as u32 + 29 * p[2] as u32) >> 8) as u8));
}

/// Which terminal color is module 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Polarity {
    /// Foreground lighter than background (a dark theme).
    Normal,
    /// Foreground darker than background (a light theme).
    Inverted,
}

/// How far [`Vision::process`] got on the last frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    /// No three big finders forming a grid corner.
    Finders,
    /// Timing lines between the finders could not be read.
    Timing,
    /// Neither format information copy decoded.
    Format,
    /// The homography did not line up with the timing lines.
    Geometry,
    /// A grid was sampled.
    Done,
}

impl Stage {
    pub fn name(self) -> &'static str {
        match self {
            Stage::Finders => "finders",
            Stage::Timing => "timing",
            Stage::Format => "format",
            Stage::Geometry => "geometry",
            Stage::Done => "done",
        }
    }
}

/// A grid found in one camera frame.
#[derive(Clone, Debug)]
pub struct Detection {
    pub format: FormatInfo,
    /// Image positions of the grid's outer corners: module (0, 0), (W, 0), (W, H), (0, H).
    pub corners: [Point; 4],
    /// Finder centres TL, TR, BR (small), BL.
    pub finders: [Point; 4],
    /// Module coordinates → image pixels.
    pub homography: Homography,
    /// Every module of the W×H grid; read tiles with `diodecam_core::frame::read_tiles`.
    pub grid: ModuleGrid,
    pub polarity: Polarity,
    /// Found by searching near the previous frame's finders.
    pub tracked: bool,
    /// 95th-percentile timing-line residual of the homography, in modules.
    pub residual: f64,
    /// The timing-line correction was applied (residual above 0.1 module).
    pub corrected: bool,
}

#[derive(Clone, Copy, Debug)]
struct Track {
    triple: Triple,
    /// Binarization window in pixels, from the module size.
    window: usize,
}

/// Grid detector with tracking state; one per camera stream.
#[derive(Default)]
pub struct Vision {
    binarizer: Binarizer,
    bitmap: Bitmap,
    sampler: Sampler,
    cands: Vec<Candidate>,
    track: Option<Track>,
    stage: Option<Stage>,
    no_correction: bool,
    /// Frames in a row without a grid: picks which fallback pass runs.
    misses: u64,
}

/// Residual above which the timing-line correction is applied: two to three
/// times the scatter of the phase measurement on a sharp, flat view. At a few
/// pixels per module even a fifth of a module costs tiles.
const CORRECTION_THRESHOLD: f64 = 0.1;
/// Residual above which the geometry is rejected even after correction.
const REJECT_THRESHOLD: f64 = 0.45;

#[derive(Clone, Copy)]
enum FiCopy {
    Top,
    Bottom,
}

impl Vision {
    pub fn new() -> Vision {
        Vision::default()
    }

    /// Forgets the tracked position.
    pub fn reset(&mut self) {
        self.track = None;
        self.stage = None;
    }

    /// How far the last [`Vision::process`] call got.
    pub fn stage(&self) -> Option<Stage> {
        self.stage
    }

    /// Turns the edge-based correction off (for comparisons in tests).
    #[doc(hidden)]
    pub fn disable_correction(&mut self, off: bool) {
        self.no_correction = off;
    }

    /// Finds and samples the grid in a `width`×`height` grayscale image
    /// (`None` also when `gray` holds fewer than `width`×`height` pixels).
    pub fn process(&mut self, gray: &[u8], width: usize, height: usize) -> Option<Detection> {
        self.stage = Some(Stage::Finders);
        if width < 64 || height < 64 || width.checked_mul(height).is_none_or(|n| gray.len() < n) {
            return None;
        }
        let img = GrayImage { data: gray, width, height };
        if let Some(track) = self.track {
            if let Some(t) = self.track_triple(&img, &track) {
                if let Some(d) = self.decode(&img, t, true) {
                    return Some(d);
                }
            }
            self.track = None;
        }
        // Full search: the design's window (long side / 40) on 3×3 means, then
        // two fallbacks — a larger window for close-ups whose finder centre is
        // wider than that, and a small one on raw pixels for tiny modules and for
        // marks next to a surround darker or lighter than the screen. The first
        // frame tries all three, so a grid of small modules is read at once;
        // while nothing is found the two fallbacks then take turns, so an empty
        // view costs two passes per frame.
        let long = width.max(height);
        let passes = [((long / 40).max(15), true), ((long / 16).max(15), true), ((long / 96).max(15), false)];
        let fallback = 1 + (self.misses % 2) as usize;
        let first = self.misses == 0;
        for (_, (window, smooth)) in passes.into_iter().enumerate().filter(|&(p, _)| p == 0 || p == fallback || first) {
            self.cands.clear();
            let all = Rect { x0: 0, y0: 0, x1: width, y1: height };
            self.binarizer.binarize(&img, all, window | 1, smooth, &mut self.bitmap);
            finder::scan(&img, &self.bitmap, 1, &mut self.cands);
            for t in finder::triples(&self.cands, 6) {
                if let Some(d) = self.decode(&img, t, false) {
                    self.misses = 0;
                    return Some(d);
                }
            }
        }
        self.misses += 1;
        None
    }

    fn reached(&mut self, stage: Stage) {
        self.stage = self.stage.max(Some(stage));
    }

    /// Looks for each finder near where it was last time.
    fn track_triple(&mut self, img: &GrayImage, track: &Track) -> Option<Triple> {
        let last = [track.triple.tl, track.triple.tr, track.triple.bl];
        let mut found = [None; 3];
        for (slot, c) in found.iter_mut().zip(last) {
            let rect = Rect::around(c.x, c.y, (c.module() * 14.0).max(40.0), img.width, img.height);
            if rect.width() < 16 || rect.height() < 16 {
                return None;
            }
            // As in the full search: the usual window first, then a small one on raw pixels.
            let small = ((c.module() * 3.0).round() as usize).max(15) | 1;
            for (window, smooth) in [(track.window, c.module() >= 4.0), (small, false)] {
                self.binarizer.binarize(img, rect, window, smooth, &mut self.bitmap);
                self.cands.clear();
                finder::scan(img, &self.bitmap, 1, &mut self.cands);
                *slot = self
                    .cands
                    .iter()
                    .filter(|k| k.bright == c.bright && k.count >= 2)
                    .max_by(|a, b| a.count.cmp(&b.count).then(b.pos().dist(c.pos()).total_cmp(&a.pos().dist(c.pos()))))
                    .copied();
                if slot.is_some() {
                    break;
                }
            }
        }
        let t = Triple { tl: found[0]?, tr: found[1]?, bl: found[2]? };
        t.is_plausible().then_some(t)
    }

    fn decode(&mut self, img: &GrayImage, t: Triple, tracked: bool) -> Option<Detection> {
        let bright = t.tl.bright;
        let (tl, tr, bl) = (t.tl.pos(), t.tr.pos(), t.bl.pos());
        self.reached(Stage::Timing);
        let (dir_top, dir_left) = ((tr - tl).unit(), (bl - tl).unit());
        let pitch_top = (t.tl.pitch_along(dir_top) + t.tr.pitch_along(dir_top)) / 2.0;
        let pitch_left = (t.tl.pitch_along(dir_left) + t.bl.pitch_along(dir_left)) / 2.0;
        let axis = |a: Point, b: Point, along: f64, across: f64| {
            timing::measure_axis(img, a, b, along, across)
                .or_else(|| timing::phase_axis(img, a, b, along, across, bright))
        };
        let top = axis(tl, tr, pitch_top, pitch_left)?;
        let left = axis(tl, bl, pitch_left, pitch_top)?;
        let h2 = timing::two_line_homography(&top, &left);

        self.reached(Stage::Format);
        // Top copy: x from the measured timing edges, the small y offset from h2.
        let along_top = |x: f64, y: f64| top.point(x) + (h2.apply(x, y) - h2.apply(x, 5.5));
        let mut format = read_fi(img, along_top, FiCopy::Top, bright, left.modules);
        let (mut w, mut h) = format.map_or((top.modules, left.modules), |f| (f.width, f.height));
        let mut hom = four_point(img, &h2, [tl, tr, bl], w, h, bright);
        if format.is_none() {
            let m = *hom.as_ref().map_or(&h2, |(m, _)| m);
            let through = |x: f64, y: f64| m.apply(x, y);
            let f = read_fi(img, through, FiCopy::Bottom, bright, h)
                .or_else(|| read_fi(img, through, FiCopy::Top, bright, h))?;
            if (f.width, f.height) != (w, h) {
                (w, h) = (f.width, f.height);
                hom = four_point(img, &h2, [tl, tr, bl], w, h, bright);
            }
            format = Some(f);
        }
        let format = format?;
        // The counts and the decoded size must describe the same grid.
        let near = |a: usize, b: usize| (a as f64 - b as f64).abs() <= 0.1 * b as f64 + 3.0;
        if !near(top.modules, w) || !near(left.modules, h) {
            return None;
        }
        let layout = Layout::from_format(format).ok()?;

        self.reached(Stage::Geometry);
        let (hom, br) = hom.unwrap_or((h2, h2.apply(w as f64 - 4.5, h as f64 - 4.5)));
        if !plausible(img, &hom, w, h) {
            return None;
        }
        let lines = [Line::Row(5), Line::Row(h - 6), Line::Col(5), Line::Col(w - 6)];
        let measured = lines.map(|l| timing::line_residuals(img, &hom, &layout, l, bright));
        let windows: usize = measured.iter().map(|m| m.1).sum();
        let res = measured.map(|m| m.0);
        let mut all: Vec<f64> = res.iter().flatten().map(|r| r.1.abs()).collect();
        // Most windows along the four timing lines must show their alternation.
        if all.is_empty() || (all.len() as f64) < timing::MIN_COHERENT_SHARE * windows as f64 {
            return None;
        }
        all.sort_by(f64::total_cmp);
        let residual = all[(all.len() * 95 / 100).min(all.len() - 1)];
        let corrected = residual > CORRECTION_THRESHOLD && !self.no_correction;
        let corr = corrected.then(|| Correction::new(w, h, [&res[0], &res[1], &res[2], &res[3]]));
        if corrected {
            // The correction absorbs along-line errors; what remains must be small.
            if line_jumps(&res) > REJECT_THRESHOLD {
                return None;
            }
        }

        let grid = self.sampler.sample(img, &hom, corr.as_ref(), &layout, bright);
        self.reached(Stage::Done);
        let module = (t.tl.module() + t.tr.module() + t.bl.module()) / 3.0;
        let long = img.width.max(img.height);
        let window = ((module * 7.0).round() as usize).clamp(15, (long / 8).max(15)) | 1;
        self.track = Some(Track { triple: t, window });
        let (wf, hf) = (w as f64, h as f64);
        Some(Detection {
            format,
            corners: [hom.apply(0.0, 0.0), hom.apply(wf, 0.0), hom.apply(wf, hf), hom.apply(0.0, hf)],
            finders: [tl, tr, br, bl],
            homography: hom,
            grid,
            polarity: if bright { Polarity::Normal } else { Polarity::Inverted },
            tracked,
            residual,
            corrected,
        })
    }
}

/// The correction follows the measured residuals, so what it cannot absorb is
/// inconsistency between neighbouring windows on a line (a stretch read off the
/// wrong modules): the 95th percentile of those jumps, in modules.
fn line_jumps(res: &[Vec<(f64, f64)>; 4]) -> f64 {
    let mut worst: Vec<f64> = Vec::new();
    for line in res {
        for pair in line.windows(2) {
            // Neighbouring boundaries should move together; a jump means a wrong edge.
            worst.push((pair[1].1 - pair[0].1).abs());
        }
    }
    worst.sort_by(f64::total_cmp);
    worst.get(worst.len() * 95 / 100).copied().unwrap_or(0.0)
}

/// The grid's corners map to finite points near the image, and no part of the
/// grid lies beyond the homography's vanishing line (the projective weight keeps
/// one sign at all four corners).
fn plausible(img: &GrayImage, hom: &Homography, w: usize, h: usize) -> bool {
    let m = &hom.0;
    let margin = 0.5 * timing::diagonal(img);
    let corners = [(0.0, 0.0), (w as f64, 0.0), (w as f64, h as f64), (0.0, h as f64)];
    let weights = corners.map(|(x, y)| m[6] * x + m[7] * y + m[8]);
    let same_sign = weights.iter().all(|&v| v > 0.0) || weights.iter().all(|&v| v < 0.0);
    same_sign && corners.iter().all(|&(x, y)| timing::near_image(img, hom.apply(x, y), margin))
}

/// Finds the small finder near its predicted place and returns the 4-point
/// homography and the finder's centre.
fn four_point(
    img: &GrayImage,
    h2: &Homography,
    [tl, tr, bl]: [Point; 3],
    w: usize,
    h: usize,
    bright: bool,
) -> Option<(Homography, Point)> {
    let (bx, by) = (w as f64 - 4.5, h as f64 - 4.5);
    let pred = h2.apply(bx, by);
    let (ju, jv) = h2.jacobian(bx, by);
    let br = finder::find_small(img, pred, ju, jv, bright, 6.0)?;
    let src =
        [Point::new(5.5, 5.5), Point::new(w as f64 - 5.5, 5.5), Point::new(bx, by), Point::new(5.5, h as f64 - 5.5)];
    let hom = Homography::from_quads(src, [tl, tr, br, bl])?;
    Some((hom, br))
}

/// Reads one FI copy, with `point` mapping module coordinates to the image. Each bit is compared with the mean of four
/// timing modules (two light, two dark) in the timing row next to it; if that fails the check, with the threshold
/// moved halfway to the mean of the bit's four neighbours (blur, as in the sampler).
fn read_fi(
    img: &GrayImage,
    point: impl Fn(f64, f64) -> Point,
    which: FiCopy,
    bright: bool,
    height: usize,
) -> Option<FormatInfo> {
    if height < 20 {
        return None;
    }
    let timing_row = match which {
        FiCopy::Top => 5,
        FiCopy::Bottom => height - 6,
    };
    let sample = |x: usize, y: usize| {
        let p = point(x as f64 + 0.5, y as f64 + 0.5);
        if p.x.is_finite() && p.y.is_finite() {
            img.box3(p.x, p.y) as f64
        } else {
            0.0
        }
    };
    let timing: Vec<f64> = (10..62).map(|x| sample(x, timing_row)).collect();
    let read = |shift: f64| {
        let mut bits = [false; FI_BITS];
        for (i, bit) in bits.iter_mut().enumerate() {
            let (x, y) = match which {
                FiCopy::Top => fi_top_position(i),
                FiCopy::Bottom => fi_bottom_position(i, height),
            };
            let a = x.saturating_sub(1).clamp(10, 54) - 10;
            let threshold = timing[a..a + 4].iter().sum::<f64>() / 4.0;
            let near = (sample(x - 1, y) + sample(x + 1, y) + sample(x, y - 1) + sample(x, y + 1)) / 4.0;
            *bit = (sample(x, y) > threshold + shift * (near - threshold)) == bright;
        }
        let fi = FormatInfo::from_bits(&bits)?;
        Layout::from_format(fi).is_ok().then_some(fi)
    };
    read(0.0).or_else(|| read(0.5))
}
