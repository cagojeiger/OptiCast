//! Timing lines (spec §2.3): 1-D profiles along a grid line, their edges, the
//! module count between two finders, and the projective spacing of modules
//! along the line — from the edges, or from the phase of the alternation when
//! blur merges them. Also the residual check of a homography against all four
//! timing lines (by phase), and the correction it yields for lens distortion.

use std::collections::VecDeque;
use std::f64::consts::PI;

use diodecam_core::layout::MAX_SIDE;
use diodecam_core::Layout;

use crate::binarize::GrayImage;
use crate::geom::{Homography, Point};

/// Longest profile sampled, in samples. Real timing lines span at most the
/// image diagonal at ≥ 0.25 px per sample; anything longer comes from a
/// degenerate geometry and is not worth reading.
pub const MAX_SAMPLES: usize = 1 << 15;

/// Whether `p` lies within the image grown by `margin` pixels on every side.
pub fn near_image(img: &GrayImage, p: Point, margin: f64) -> bool {
    p.x.is_finite()
        && p.y.is_finite()
        && p.x >= -margin
        && p.y >= -margin
        && p.x <= img.width as f64 + margin
        && p.y <= img.height as f64 + margin
}

pub fn diagonal(img: &GrayImage) -> f64 {
    (img.width as f64).hypot(img.height as f64)
}

/// Gray levels sampled every `step` pixels along `origin + s·dir`, s from `start`.
pub struct Profile {
    pub start: f64,
    pub step: f64,
    pub values: Vec<f64>,
}

impl Profile {
    /// Samples s ∈ [from, to]; each sample averages five points spread up to
    /// `half_width` pixels across the line (along `across`, a unit vector).
    /// Empty if that would take more than [`MAX_SAMPLES`] samples.
    #[allow(clippy::too_many_arguments)]
    pub fn sample(
        img: &GrayImage,
        origin: Point,
        dir: Point,
        from: f64,
        to: f64,
        step: f64,
        half_width: f64,
        across: Point,
    ) -> Profile {
        let span = (to - from) / step;
        if !(span.is_finite() && span >= 0.0 && span < MAX_SAMPLES as f64) {
            return Profile { start: from, step, values: Vec::new() };
        }
        let n = span.floor() as usize + 1;
        let (o1, o2) = (across * half_width, across * (half_width / 2.0));
        let values = (0..n)
            .map(|i| {
                let p = origin + dir * (from + i as f64 * step);
                [p, p + o1, p - o1, p + o2, p - o2].iter().map(|q| img.bilinear(q.x, q.y)).sum::<f64>() / 5.0
            })
            .collect();
        Profile { start: from, step, values }
    }

    /// The same profile smoothed by a centered box of radius `r` samples.
    pub fn smoothed(&self, r: usize) -> Profile {
        Profile { start: self.start, step: self.step, values: self.moving_mean(r) }
    }

    /// Centered moving average of radius `r` samples.
    pub fn moving_mean(&self, r: usize) -> Vec<f64> {
        let n = self.values.len();
        let mut prefix = Vec::with_capacity(n + 1);
        prefix.push(0.0);
        for &v in &self.values {
            prefix.push(prefix.last().copied().unwrap_or(0.0) + v);
        }
        (0..n)
            .map(|i| {
                let (a, b) = (i.saturating_sub(r), (i + r + 1).min(n));
                (prefix[b] - prefix[a]) / (b - a) as f64
            })
            .collect()
    }

    /// Per-sample threshold: the midpoint of the local minimum and maximum of a
    /// lightly smoothed profile within ±`r` samples. Unlike a moving mean it stays
    /// centred next to large single-color areas (finders, borders).
    pub fn envelope_mid(&self, r: usize, smooth: usize) -> Vec<f64> {
        let s = self.moving_mean(smooth);
        let (lo, hi) = (sliding(&s, r, |a, b| a <= b), sliding(&s, r, |a, b| a >= b));
        lo.iter().zip(&hi).map(|(a, b)| (a + b) / 2.0).collect()
    }

    pub fn edges_fixed(&self, threshold: f64, min_run: f64) -> Vec<f64> {
        self.edges(&vec![threshold; self.values.len()], min_run)
    }

    /// Positions (in s) where the profile crosses `threshold`, ignoring runs
    /// shorter than `min_run` samples (noise), with sub-sample interpolation.
    pub fn edges(&self, threshold: &[f64], min_run: f64) -> Vec<f64> {
        let v = &self.values;
        if v.len() < 2 {
            return Vec::new();
        }
        // Runs of samples above/below the threshold: (first index, length).
        let mut runs: Vec<(usize, usize)> = Vec::new();
        let mut start = 0;
        for i in 1..=v.len() {
            if i == v.len() || (v[i] > threshold[i]) != (v[start] > threshold[start]) {
                runs.push((start, i - start));
                start = i;
            }
        }
        // Merge each interior run that is too short into its two neighbours (which
        // share a color), left to right in one pass.
        let mut kept: Vec<(usize, usize)> = Vec::with_capacity(runs.len());
        for run in runs {
            kept.push(run);
            let n = kept.len();
            if n >= 3 && (kept[n - 2].1 as f64) < min_run {
                let (b, c) = (kept[n - 2].1, kept[n - 1].1);
                kept.truncate(n - 2);
                kept[n - 3].1 += b + c;
            }
        }
        kept.iter()
            .skip(1)
            .map(|&(i, _)| {
                let d0 = v[i - 1] - threshold[i - 1];
                let d1 = v[i] - threshold[i];
                let f = if d0 != d1 { (d0 / (d0 - d1)).clamp(0.0, 1.0) } else { 0.5 };
                self.start + (i as f64 - 1.0 + f) * self.step
            })
            .collect()
    }
}

/// Running minimum (`keep(a, b)` = a ≤ b) or maximum (a ≥ b) over ±`r` samples,
/// in O(n) with a monotonic deque.
fn sliding(v: &[f64], r: usize, keep: impl Fn(f64, f64) -> bool) -> Vec<f64> {
    let n = v.len();
    let mut out = Vec::with_capacity(n);
    let mut q: VecDeque<usize> = VecDeque::new();
    let mut next = 0;
    for i in 0..n {
        // Window [i − r, i + r]: add up to i + r, drop below i − r.
        while next < n && next <= i + r {
            while q.back().is_some_and(|&j| keep(v[next], v[j])) {
                q.pop_back();
            }
            q.push_back(next);
            next += 1;
        }
        while q.front().is_some_and(|&j| j + r < i) {
            q.pop_front();
        }
        out.push(v[q[0]]);
    }
    out
}

/// Projective spacing along a line: module offset t ↦ distance s = αt / (1 + βt).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxisFit {
    pub alpha: f64,
    pub beta: f64,
}

impl AxisFit {
    pub fn s(&self, t: f64) -> f64 {
        self.alpha * t / (1.0 + self.beta * t)
    }

    /// ds/dt: the local module pitch in pixels.
    pub fn pitch(&self, t: f64) -> f64 {
        let d = 1.0 + self.beta * t;
        self.alpha / (d * d)
    }

    /// The inverse of [`AxisFit::s`]: module offset at distance `s`.
    pub fn t(&self, s: f64) -> f64 {
        s / (self.alpha - self.beta * s)
    }

    /// Least squares on the linearized form s = αt − βts, each point weighted.
    fn fit(points: &[(f64, f64, f64)]) -> Option<AxisFit> {
        let (mut a11, mut a12, mut a22, mut b1, mut b2) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for &(t, s, w) in points {
            a11 += w * t * t;
            a12 -= w * t * t * s;
            a22 += w * t * t * s * s;
            b1 += w * t * s;
            b2 -= w * t * s * s;
        }
        let det = a11 * a22 - a12 * a12;
        if det.abs() < 1e-12 * a11 * a22 || det == 0.0 {
            return None;
        }
        let fit = AxisFit { alpha: (b1 * a22 - a12 * b2) / det, beta: (a11 * b2 - a12 * b1) / det };
        (fit.alpha.is_finite() && fit.beta.is_finite() && fit.alpha > 0.0).then_some(fit)
    }
}

/// The grid line from one big finder's centre to another's, measured on its
/// timing line: how many modules the grid has along it, and where each module is.
#[derive(Clone, Debug, PartialEq)]
pub struct Axis {
    /// W (top line) or H (left line).
    pub modules: usize,
    pub fit: AxisFit,
    pub origin: Point,
    pub dir: Point,
    pub length: f64,
    /// Largest residual of the fit over its points, in modules.
    pub residual: f64,
    /// The points the fit went through as (module coordinate, s), in order: module
    /// boundaries from [`measure_axis`], phase points from [`phase_axis`].
    pub edges: Vec<(f64, f64)>,
}

impl Axis {
    /// The axis from `origin` (module 5.5) along `dir` through the fitted
    /// `points` (module offset from 5.5, s, weight) and the centre itself.
    fn new(
        modules: usize,
        fit: AxisFit,
        origin: Point,
        dir: Point,
        length: f64,
        residual: f64,
        points: &[(f64, f64, f64)],
    ) -> Axis {
        let mut edges: Vec<(f64, f64)> = points.iter().map(|&(t, s, _)| (t + 5.5, s)).collect();
        edges.push((5.5, 0.0));
        edges.sort_by(|a, b| a.0.total_cmp(&b.0));
        Axis { modules, fit, origin, dir, length, residual, edges }
    }

    /// Distance along the line of module coordinate `c`: interpolated between
    /// measured edges where there are any, from the fit elsewhere.
    pub fn s_at(&self, c: f64) -> f64 {
        let e = &self.edges;
        match e.iter().position(|p| p.0 >= c) {
            Some(i) if i > 0 => {
                let (a, b) = (e[i - 1], e[i]);
                a.1 + (b.1 - a.1) * (c - a.0) / (b.0 - a.0)
            }
            _ => self.fit.s(c - 5.5),
        }
    }

    pub fn point(&self, c: f64) -> Point {
        self.origin + self.dir * self.s_at(c)
    }
}

/// Module count and spacing along the centre line of the finders at `a` (module
/// coordinate 5.5) and `b` (count − 5.5). Between them the line runs through a
/// finder centre, gap, ring, separator, the alternating timing line, then the
/// mirror image: one edge per module boundary 7 … count − 7, except that an even
/// count has no edge at count − 10 (the last timing module and the separator are
/// both 0). Either way n is even: count = n + 13 if every gap is one module, or
/// n + 14 if the fourth gap from the far end spans two.
/// `across` is the module pitch perpendicular to the line (vt100 modules are
/// twice as tall as wide), which bounds how far the profile may average sideways.
pub fn measure_axis(img: &GrayImage, a: Point, b: Point, pitch_guess: f64, across: f64) -> Option<Axis> {
    let length = a.dist(b);
    if pitch_guess.is_nan() || pitch_guess <= 0.5 || length < 10.0 * pitch_guess {
        return None;
    }
    let dir = (b - a).unit();
    let normal = dir.perp();
    let half_width = 0.25 * across.min(pitch_guess * 2.0);
    let mut pitch = pitch_guess;
    let mut edges = Vec::new();
    for pass in 0..2 {
        let step = (pitch / 4.0).clamp(0.25, 1.0);
        let p = Profile::sample(img, a, dir, -4.6 * pitch, length + 4.6 * pitch, step, half_width, normal)
            .smoothed((pitch / 6.0 / step).round() as usize);
        let t = p.envelope_mid((2.5 * pitch / step).round() as usize, 0);
        edges = p.edges(&t, 0.35 * pitch / step);
        let interior: Vec<f64> =
            edges.iter().copied().filter(|&s| s > 0.6 * pitch && s < length - 0.6 * pitch).collect();
        if interior.len() < 4 {
            return None;
        }
        let mut gaps: Vec<f64> = interior.windows(2).map(|w| w[1] - w[0]).collect();
        gaps.sort_by(f64::total_cmp);
        let median = gaps[gaps.len() / 2];
        if pass == 0 {
            pitch = median;
        }
    }
    let interior: Vec<f64> = edges.iter().copied().filter(|&s| s > 0.6 * pitch && s < length - 0.6 * pitch).collect();
    let n = interior.len();
    if n % 2 == 1 {
        return None;
    }
    let double = interior[n - 3] - interior[n - 4];
    let single = (interior[n - 2] - interior[n - 3] + interior[n - 1] - interior[n - 2]) / 2.0;
    let modules = if double > 1.5 * single { n + 14 } else { n + 13 };
    // Sanity: the count must agree with the finder distance and the median pitch.
    let estimate = length / pitch + 11.0;
    if (modules as f64 - estimate).abs() > 0.2 * estimate + 2.0 {
        return None;
    }
    let boundary = |k: usize| if modules % 2 == 1 || k + 18 <= modules { 7 + k } else { 8 + k };
    // Every gap must be about one module (two at the skipped boundary) relative to
    // its neighbours: a missed or extra edge breaks this locally, whatever the
    // perspective or lens distortion does to the spacing overall.
    let unit: Vec<f64> =
        interior.windows(2).enumerate().map(|(k, w)| (w[1] - w[0]) / (boundary(k + 1) - boundary(k)) as f64).collect();
    // A displaced edge (short gap next to a long one, summing to two) is fine.
    for k in 0..unit.len() {
        let mut near: Vec<f64> = unit[k.saturating_sub(3)..(k + 4).min(unit.len())].to_vec();
        near.sort_by(f64::total_cmp);
        let median = near[near.len() / 2];
        if (0.55..1.6).contains(&(unit[k] / median)) {
            continue;
        }
        let pair_ok = |j: Option<usize>| {
            j.and_then(|j| unit.get(j)).is_some_and(|&u| (0.8..1.25).contains(&((unit[k] + u) / (2.0 * median))))
        };
        if !pair_ok(k.checked_sub(1)) && !pair_ok(Some(k + 1)) {
            return None;
        }
    }
    let far = (modules - 11) as f64;
    let mut points: Vec<(f64, f64, f64)> =
        interior.iter().enumerate().map(|(k, &s)| (boundary(k) as f64 - 5.5, s, 1.0)).collect();
    points.push((far, length, 4.0));
    let mut fit = AxisFit::fit(&points)?;
    // The finder rings outside the two centres: boundaries 4, 3, 2 and count − 4, − 3, − 2.
    let mut before: Vec<f64> = edges.iter().copied().filter(|&s| s < -0.6 * pitch).collect();
    before.reverse();
    let after: Vec<f64> = edges.iter().copied().filter(|&s| s > length + 0.6 * pitch).collect();
    let extra = before
        .iter()
        .zip([-1.5, -2.5, -3.5])
        .chain(after.iter().zip([far + 1.5, far + 2.5, far + 3.5]))
        .map(|(&s, t)| (t, s, 1.0));
    let accepted: Vec<_> = extra.filter(|&(t, s, _)| ((s - fit.s(t)) / fit.pitch(t)).abs() < 0.3).collect();
    if !accepted.is_empty() {
        points.extend(accepted);
        fit = AxisFit::fit(&points)?;
    }
    let residual = points.iter().map(|&(t, s, _)| ((s - fit.s(t)) / fit.pitch(t)).abs()).fold(0.0, f64::max);
    // Only a gross misfit: the local check above already vouches for the count.
    if residual > 1.0 {
        return None;
    }
    Some(Axis::new(modules, fit, a, dir, length, residual, &points))
}

/// Width of a phase window, in modules: four periods of the timing pattern.
const PHASE_WINDOW: f64 = 8.0;
/// Least coherence of a window that counts as timing pattern (1 = a clean
/// alternation, about 1/√samples for unrelated modules).
const MIN_COHERENCE: f64 = 0.6;
/// Share of the windows on a timing line (or on all four) that must be coherent.
/// A timing line under heavy blur keeps about 0.7 (the data rows beside it bleed
/// in); a line through data keeps under 0.2. A geometry off in scale still sees
/// the alternation in every window and stays coherent: only the offsets show it.
pub const MIN_COHERENT_SHARE: f64 = 0.5;

/// Where the timing pattern (1 on modules [10 + 2k, 11 + 2k), spec §2.3) sits in
/// one window of samples `v` that the current model places at module
/// coordinates `c`: the pattern's offset from there in modules (−1, 1] (the true
/// coordinate of a sample is c + offset), and the window's coherence. Only the
/// fundamental is used, and a symmetric blur leaves its phase alone.
fn window_phase(c: &[f64], v: &[f64], bright: bool) -> (f64, f64) {
    let n = v.len() as f64;
    let mean = v.iter().sum::<f64>() / n;
    let (mut re, mut im, mut energy) = (0.0, 0.0, 0.0);
    for (&c, &v) in c.iter().zip(v) {
        let d = if bright { v - mean } else { mean - v };
        let (sin, cos) = (std::f64::consts::PI * (c - 10.5)).sin_cos();
        re += d * cos;
        im -= d * sin;
        energy += d * d;
    }
    let coherence = re.hypot(im) / (n * energy / 2.0).sqrt().max(1e-9);
    (im.atan2(re) / std::f64::consts::PI, coherence)
}

/// The pitch in [0.75, 1.33] × `guess` (2 % steps) at which phase windows over
/// the profile `v` (samples `step` pixels apart) add up to the strongest
/// alternation. Windows add by magnitude, so perspective (a pitch that drifts
/// along the line) only blurs the peak.
fn best_pitch(v: &[f64], step: f64, guess: f64) -> f64 {
    let mut best = (f64::MIN, guess);
    let mut pitch = 0.75 * guess;
    while pitch < 1.34 * guess {
        let len = ((PHASE_WINDOW * pitch / step).round() as usize).max(2);
        // The phase advances by π·step/pitch per sample: rotate instead of sin/cos per sample.
        let (sin, cos) = (std::f64::consts::PI * step / pitch).sin_cos();
        let (mut total, mut covered) = (0.0, 0);
        for window in v.chunks_exact(len) {
            let (mut re, mut im, mut ur, mut ui, mut sum) = (0.0, 0.0, 0.0, 0.0, 0.0);
            let (mut er, mut ei) = (1.0, 0.0);
            for &x in window {
                (re, im, ur, ui, sum) = (re + x * er, im + x * ei, ur + er, ui + ei, sum + x);
                (er, ei) = (er * cos - ei * sin, er * sin + ei * cos);
            }
            // Σ (v − mean)·e^{iθ} over the window.
            let mean = sum / len as f64;
            total += (re - mean * ur).hypot(im - mean * ui);
            covered += len;
        }
        if covered > 0 && total / covered as f64 > best.0 {
            best = (total / covered as f64, pitch);
        }
        pitch *= 1.02;
    }
    best.1
}

/// Blur-tolerant [`measure_axis`]: instead of resolving every edge, the phase
/// of the alternating timing line in overlapping windows, unwrapped along the
/// line and fitted with the projective spacing. The fit runs through the
/// finder centre at `a` (module 5.5); the count follows from where it puts the
/// centre at `b` (count − 5.5), which must land on a module centre.
pub fn phase_axis(img: &GrayImage, a: Point, b: Point, pitch_guess: f64, across: f64, bright: bool) -> Option<Axis> {
    let length = a.dist(b);
    if pitch_guess.is_nan() || pitch_guess <= 0.5 || length < 30.0 * pitch_guess {
        return None;
    }
    let dir = (b - a).unit();
    let half_width = 0.25 * across.min(pitch_guess * 2.0);
    let step = (pitch_guess / 4.0).clamp(0.25, 1.0);
    let profile = Profile::sample(img, a, dir, 0.0, length, step, half_width, dir.perp());
    let n = profile.values.len();
    // The finders' run lengths give the pitch to 10–15 %; the alternation over
    // the whole line pins it down.
    let guard = ((6.0 * pitch_guess / step) as usize).min(n / 4);
    let pitch = best_pitch(&profile.values[guard..n - guard], step, pitch_guess);
    // The timing modules start 4.5 modules from either centre; half a module more
    // keeps the windows off the separators.
    let i0 = ((5.0 * pitch / step).ceil() as usize).min(n);
    let i1 = (((length - 5.0 * pitch) / step).floor().max(0.0) as usize + 1).min(n);
    if i1 < i0 + 2 {
        return None;
    }
    let s: Vec<f64> = (i0..i1).map(|i| i as f64 * step).collect();
    let values = &profile.values[i0..i1];
    let mut model = AxisFit { alpha: pitch, beta: 0.0 };
    let mut points: Vec<(f64, f64, f64)> = Vec::new();
    let mut coherent = 0.0;
    for pass in 0..2 {
        let c: Vec<f64> = s.iter().map(|&s| 5.5 + model.t(s)).collect();
        // Monotonic, and no longer than the largest grid: a degenerate model would
        // otherwise spread the windows over thousands of modules.
        if !c.windows(2).all(|w| w[1] > w[0]) || c[c.len() - 1] > MAX_SIDE as f64 + 16.0 {
            return None;
        }
        // Windows one period apart, wholly inside the sampled stretch.
        let (first, last) = (c[0] + PHASE_WINDOW / 2.0, c[c.len() - 1] - PHASE_WINDOW / 2.0);
        let mut windows = Vec::new();
        let mut centre = first;
        while centre <= last {
            let i0 = c.partition_point(|&x| x < centre - PHASE_WINDOW / 2.0);
            let i1 = c.partition_point(|&x| x < centre + PHASE_WINDOW / 2.0);
            let (offset, k) = window_phase(&c[i0..i1], &values[i0..i1], bright);
            windows.push((centre, offset, k));
            centre += 2.0;
        }
        if windows.len() < 3 {
            return None;
        }
        coherent = windows.iter().filter(|w| w.2 >= MIN_COHERENCE).count() as f64 / windows.len() as f64;
        // Unwrap: neighbouring windows are two modules apart, so their offsets differ
        // by far less than a period unless the model is off by 50 %.
        let mut prev: Option<f64> = None;
        let unwrapped: Vec<(f64, f64, f64)> = windows
            .iter()
            .filter(|w| w.2 >= MIN_COHERENCE)
            .map(|&(centre, offset, k)| {
                let off = match prev {
                    Some(p) => offset + 2.0 * ((p - offset) / 2.0).round(),
                    None => offset,
                };
                prev = Some(off);
                (centre, off, k)
            })
            .collect();
        if unwrapped.len() < 3 {
            return None;
        }
        // Near TL even a pitch a few per cent off keeps the first window within a
        // period of the truth; a shift by a whole period is tried anyway and must fit worse.
        let shifts: &[f64] = if pass == 0 { &[0.0, -2.0, 2.0] } else { &[0.0] };
        let mut best: Option<(f64, AxisFit)> = None;
        for &shift in shifts {
            let pts: Vec<(f64, f64, f64)> = unwrapped
                .iter()
                .map(|&(centre, off, k)| (centre + off + shift - 5.5, model.s(centre - 5.5), k))
                .collect();
            let Some(fit) = AxisFit::fit(&pts) else { continue };
            let rms = (pts.iter().map(|&(t, s, w)| w * (fit.t(s) - t).powi(2)).sum::<f64>()
                / pts.iter().map(|p| p.2).sum::<f64>())
            .sqrt();
            if best.is_none_or(|b| rms < b.0) {
                best = Some((rms, fit));
                points = pts;
            }
        }
        model = best?.1;
    }
    let far_t = model.t(length);
    if !far_t.is_finite() || far_t < 10.0 {
        return None;
    }
    let far = far_t.round();
    let modules = far as usize + 11;
    let weight: f64 = points.iter().map(|p| p.2).sum();
    points.push((far, length, 0.25 * weight));
    let fit = AxisFit::fit(&points)?;
    let residual = points.iter().map(|&(t, s, _)| (fit.t(s) - t).abs()).fold(0.0, f64::max);
    // The finder centre must sit on a module centre of the fitted spacing, most
    // windows must show the pattern, and none may stray far from the fit.
    if (far_t - far).abs() > 0.3 || coherent < MIN_COHERENT_SHARE || residual > 0.5 {
        return None;
    }
    Some(Axis::new(modules, fit, a, dir, length, residual, &points))
}

/// The homography fixed by the two measured lines through the TL finder
/// (module (5.5, 5.5)): along each, a 1-D projective spacing. With u = x − 5.5,
/// v = y − 5.5: H(u, v) = TL + (α_r u e_r + α_c v e_c) / (1 + β_r u + β_c v).
pub fn two_line_homography(top: &Axis, left: &Axis) -> Homography {
    let o = top.origin;
    let (a, b) = (top.fit.alpha, top.fit.beta);
    let (g, d) = (left.fit.alpha, left.fit.beta);
    let (er, ec) = (top.dir, left.dir);
    let m = Homography([
        a * er.x + b * o.x,
        g * ec.x + d * o.x,
        o.x,
        a * er.y + b * o.y,
        g * ec.y + d * o.y,
        o.y,
        b,
        d,
        1.0,
    ]);
    m.compose(&Homography([1.0, 0.0, -5.5, 0.0, 1.0, -5.5, 0.0, 0.0, 1.0]))
}

/// One of the four timing lines, by module row or column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Line {
    Row(usize),
    Col(usize),
}

/// How far one timing line sits from where `hom` puts it: the phase of its
/// alternating stretch (spec §2.3: 1 on [10 + 2k, 11 + 2k)), sampled through
/// `hom` in module coordinates, in windows one module apart. Unlike its edges,
/// the phase survives blur that merges 1-module modules. Returns (window
/// centre, measured − predicted in modules) for every coherent window, unwrapped
/// along the line ([`unwrap_offsets`]), and how many windows there were.
pub fn line_residuals(
    img: &GrayImage,
    hom: &Homography,
    layout: &Layout,
    line: Line,
    bright: bool,
) -> (Vec<(f64, f64)>, usize) {
    // Eight samples per module, each the mean of five points across the line.
    const PER_MODULE: usize = 8;
    let len = match line {
        Line::Row(_) => layout.width(),
        Line::Col(_) => layout.height(),
    };
    let value = |c: usize| match line {
        Line::Row(y) => layout.fixed(c, y),
        Line::Col(x) => layout.fixed(x, c),
    };
    // Module coordinates of the point `c` along the line, on its centre line.
    let at = |c: f64| match line {
        Line::Row(y) => (c, y as f64 + 0.5),
        Line::Col(x) => (x as f64 + 0.5, c),
    };
    let point = |c: f64| {
        let (x, y) = at(c);
        hom.apply(x, y)
    };
    let end = (10..len).find(|&c| value(c) != Some((c - 10) % 2 == 0)).unwrap_or(len);
    // Timing lines run between finders inside the view; a line thrown far
    // outside it by a degenerate homography is not read at all.
    let margin = 0.05 * diagonal(img);
    let span = PHASE_WINDOW as usize;
    if end.saturating_sub(10) < span
        || !near_image(img, point(10.0), margin)
        || !near_image(img, point(end as f64), margin)
    {
        return (Vec::new(), 0);
    }
    // Sample i sits at c = 10 + (i + ½)/8, where the pattern's phase π(c − 10.5)
    // is π(i − 3.5)/8: sixteen values, one period.
    let wave: [(f64, f64); 2 * PER_MODULE] =
        std::array::from_fn(|i| (PI * (i as f64 - 3.5) / PER_MODULE as f64).sin_cos());
    // Per module of the line: Σv, Σv², Σv·cos, Σv·sin over its samples. The
    // points across the line step along the image of one module across it there.
    let sums: Vec<[f64; 4]> = (10..end)
        .map(|m| {
            let (x, y) = at(m as f64 + 0.5);
            let (ju, jv) = hom.jacobian(x, y);
            let across = match line {
                Line::Row(_) => jv,
                Line::Col(_) => ju,
            };
            let mut s = [0.0; 4];
            for j in 0..PER_MODULE {
                let i = (m - 10) * PER_MODULE + j;
                let p = point(10.0 + (i as f64 + 0.5) / PER_MODULE as f64);
                let v = [0.0, 0.25, -0.25, 0.125, -0.125]
                    .iter()
                    .map(|&d| {
                        let q = p + across * d;
                        img.bilinear(q.x, q.y)
                    })
                    .sum::<f64>()
                    / 5.0;
                let (sin, cos) = wave[i % wave.len()];
                s = [s[0] + v, s[1] + v * v, s[2] + v * cos, s[3] + v * sin];
            }
            s
        })
        .collect();
    // Windows of eight modules, one module apart. A window spans whole periods,
    // so the wave sums to zero over it and the window's mean drops out.
    let n = (span * PER_MODULE) as f64;
    let windows = sums.len() + 1 - span;
    let mut out = Vec::new();
    for k in 0..windows {
        let s = sums[k..k + span].iter().fold([0.0; 4], |a, m| [a[0] + m[0], a[1] + m[1], a[2] + m[2], a[3] + m[3]]);
        let (re, im) = if bright { (s[2], -s[3]) } else { (-s[2], s[3]) };
        let energy = (s[1] - s[0] * s[0] / n).max(0.0);
        let coherence = re.hypot(im) / (n * energy / 2.0).sqrt().max(1e-9);
        if coherence >= MIN_COHERENCE {
            // The pattern sits `offset` further on, so its boundaries show up that
            // much earlier. Window k covers modules [10 + k, 18 + k).
            let offset = im.atan2(re) / PI;
            out.push(((10 + k + span / 2) as f64, -offset));
        }
    }
    unwrap_offsets(&mut out);
    (out, windows)
}

/// Unwraps the offsets (−1, 1] of one line's windows (centre, offset) in place.
/// Windows at most two modules apart share at least ¾ of their samples, so their
/// offsets differ by far less than a period: each such run is unwrapped. A run
/// as long as a window also continues from the previous such run across the
/// gap; shorter runs may be noise and are left as measured.
fn unwrap_offsets(line: &mut [(f64, f64)]) {
    // `b` moved by whole periods to the nearest of `a`.
    let nearest = |a: f64, b: f64| b + 2.0 * ((a - b) / 2.0).round();
    let mut last: Option<f64> = None;
    let mut start = 0;
    while start < line.len() {
        let mut end = start + 1;
        while end < line.len() && line[end].0 - line[end - 1].0 <= 2.0 {
            end += 1;
        }
        let long = end - start >= PHASE_WINDOW as usize;
        if let (true, Some(l)) = (long, last) {
            line[start].1 = nearest(l, line[start].1);
        }
        for k in start + 1..end {
            line[k].1 = nearest(line[k - 1].1, line[k].1);
        }
        if long {
            last = Some(line[end - 1].1);
        }
        start = end;
    }
}

/// Along-line displacement measured on the four timing lines, blended into the
/// interior (a Coons-style patch): module (x, y) is sampled at H(x + δx, y + δy).
#[derive(Clone, Debug, PartialEq)]
pub struct Correction {
    width: usize,
    height: usize,
    top: Vec<f64>,
    bottom: Vec<f64>,
    left: Vec<f64>,
    right: Vec<f64>,
}

impl Correction {
    /// From residual lists of the top/bottom rows (δx) and left/right columns (δy).
    pub fn new(width: usize, height: usize, lines: [&[(f64, f64)]; 4]) -> Correction {
        let table = |points: &[(f64, f64)], len: usize| -> Vec<f64> {
            (0..=len)
                .map(|c| {
                    let c = c as f64;
                    let after = points.iter().position(|p| p.0 >= c);
                    match after {
                        _ if points.is_empty() => 0.0,
                        Some(0) => points[0].1,
                        None => points[points.len() - 1].1,
                        Some(i) => {
                            let (a, b) = (points[i - 1], points[i]);
                            a.1 + (b.1 - a.1) * (c - a.0) / (b.0 - a.0)
                        }
                    }
                })
                .collect()
        };
        let [top, bottom, left, right] = lines;
        Correction {
            width,
            height,
            top: table(top, width),
            bottom: table(bottom, width),
            left: table(left, height),
            right: table(right, height),
        }
    }

    fn lookup(table: &[f64], c: f64) -> f64 {
        let c = c.clamp(0.0, (table.len() - 1) as f64);
        let i = (c.floor() as usize).min(table.len() - 2);
        let f = c - i as f64;
        table[i] * (1.0 - f) + table[i + 1] * f
    }

    /// Corrected module coordinate for (x, y).
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let tx = ((x - 5.5) / (self.width as f64 - 11.0)).clamp(0.0, 1.0);
        let ty = ((y - 5.5) / (self.height as f64 - 11.0)).clamp(0.0, 1.0);
        let dx = Self::lookup(&self.top, x) * (1.0 - ty) + Self::lookup(&self.bottom, x) * ty;
        let dy = Self::lookup(&self.left, y) * (1.0 - tx) + Self::lookup(&self.right, y) * tx;
        (x + dx, y + dy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_ignore_short_blips() {
        let mut values = vec![0.0; 40];
        values[10..20].fill(100.0);
        values[25] = 100.0; // one-sample spike
        values[30..40].fill(100.0);
        let p = Profile { start: 0.0, step: 1.0, values };
        let e = p.edges_fixed(50.0, 2.0);
        assert_eq!(e, [9.5, 19.5, 29.5]);
    }

    #[test]
    fn axis_fit_recovers_projective_spacing() {
        let truth = AxisFit { alpha: 6.0, beta: 0.002 };
        let pts: Vec<(f64, f64, f64)> = (0..150).map(|t| (t as f64, truth.s(t as f64), 1.0)).collect();
        let fit = AxisFit::fit(&pts).unwrap();
        assert!((fit.alpha - 6.0).abs() < 1e-9 && (fit.beta - 0.002).abs() < 1e-12);
    }

    #[test]
    fn sliding_min_max_match_a_direct_scan() {
        let v: Vec<f64> = (0..300).map(|i| ((i * 7919) % 101) as f64).collect();
        for r in [0, 1, 4, 37, 400] {
            let lo = sliding(&v, r, |a, b| a <= b);
            let hi = sliding(&v, r, |a, b| a >= b);
            for i in 0..v.len() {
                let w = &v[i.saturating_sub(r)..(i + r + 1).min(v.len())];
                assert_eq!(lo[i], w.iter().copied().fold(f64::MAX, f64::min), "r {r} i {i}");
                assert_eq!(hi[i], w.iter().copied().fold(f64::MIN, f64::max), "r {r} i {i}");
            }
        }
    }

    #[test]
    fn profiles_are_bounded() {
        let data = vec![128u8; 64 * 64];
        let img = GrayImage { data: &data, width: 64, height: 64 };
        let dir = Point::new(1.0, 0.0);
        let p = Profile::sample(&img, Point::new(0.0, 0.0), dir, 0.0, 1e9, 0.25, 1.0, dir.perp());
        assert!(p.values.is_empty());
        let p = Profile::sample(&img, Point::new(0.0, 0.0), dir, 0.0, f64::NAN, 0.25, 1.0, dir.perp());
        assert!(p.values.is_empty());
        let p = Profile::sample(&img, Point::new(0.0, 0.0), dir, 0.0, 60.0, 0.25, 1.0, dir.perp());
        assert_eq!(p.values.len(), 241);
    }

    /// Review probe: a homography that throws the far end of a timing line
    /// hundreds of times further than head-on used to make this quadratic in
    /// the line length. Such lines are now refused up front.
    #[test]
    fn line_residuals_cost_is_bounded_for_degenerate_homographies() {
        let layout = Layout::new(diodecam_core::Profile::Ssh, 199, 106).unwrap();
        let data = vec![128u8; 1280 * 720];
        let img = GrayImage { data: &data, width: 1280, height: 720 };
        for eps in [1e-1, 3e-2, 1e-2, 5e-3, 1e-4] {
            let m6 = -(1.0 - eps) / 198.0;
            let hom = Homography([6.0, 0.0, 40.0, 0.0, 6.0, 40.0, m6, 0.0, 1.0]);
            let t = std::time::Instant::now();
            let (out, _) = line_residuals(&img, &hom, &layout, Line::Row(100), true);
            assert!(t.elapsed().as_millis() < 200, "eps {eps}: {:?}", t.elapsed());
            assert!(out.is_empty());
        }
    }

    #[test]
    fn offsets_unwrap_along_runs() {
        let wrap = |x: f64| x - 2.0 * ((x - 1.0) / 2.0).ceil();
        // One run of neighbouring windows: a drift past one module comes back whole.
        let ramp: Vec<(f64, f64)> = (0..40).map(|i| (14.0 + i as f64, 0.05 * i as f64)).collect();
        let mut line: Vec<(f64, f64)> = ramp.iter().map(|&(c, r)| (c, wrap(r))).collect();
        assert!(line.iter().any(|r| r.1 < 0.0));
        unwrap_offsets(&mut line);
        assert!(line.iter().zip(&ramp).all(|(a, b)| (a.1 - b.1).abs() < 1e-9));
        // A long run continues the previous long run across a gap; a short run
        // (two windows of noise) neither moves nor carries the reference.
        let mut line = vec![(14.0, 0.85), (15.0, 0.8)];
        line.extend((0..10).map(|i| (40.0 + i as f64, 0.6 + 0.03 * i as f64)));
        line.extend((0..10).map(|i| (60.0 + i as f64, wrap(1.1 + 0.03 * i as f64))));
        unwrap_offsets(&mut line);
        assert_eq!(&line[..2], &[(14.0, 0.85), (15.0, 0.8)]);
        assert!((line[2].1 - 0.6).abs() < 1e-9 && (line[21].1 - 1.37).abs() < 1e-9, "{line:?}");
    }

    #[test]
    fn correction_interpolates() {
        let c = Correction::new(100, 50, [&[(10.0, 0.2), (20.0, 0.4)], &[], &[], &[]]);
        let (x, _) = c.apply(15.0, 5.5);
        assert!((x - 15.3).abs() < 1e-9);
        let (x, y) = c.apply(15.0, 44.5);
        assert!((x - 15.0).abs() < 1e-9 && (y - 44.5).abs() < 1e-9);
    }
}
