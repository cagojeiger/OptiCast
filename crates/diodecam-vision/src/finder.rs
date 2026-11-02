//! Finder marks (spec §2.2, `docs/web.md` §7): run-length search for the big
//! 1:1:3:1:1 marks in both polarities, cross-checked vertically, horizontally and
//! diagonally; the small bottom-right mark by template search near a prediction.

use crate::binarize::{Bitmap, GrayImage};
use crate::geom::Point;
use crate::timing::{diagonal, near_image, Profile};

/// A big finder seen in the image.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Candidate {
    pub x: f64,
    pub y: f64,
    /// Horizontal / vertical extent of the mark through its centre, ÷ 7 (pixels).
    pub mh: f64,
    pub mv: f64,
    /// Ring and centre are brighter than the gap: the terminal foreground is the light color.
    pub bright: bool,
    /// Rows that confirmed it.
    pub count: u32,
}

impl Candidate {
    pub fn pos(&self) -> Point {
        Point::new(self.x, self.y)
    }

    pub fn module(&self) -> f64 {
        (self.mh + self.mv) / 2.0
    }

    /// Module pitch along the unit direction `d`: a chord through the centre of a
    /// rotated square is longer than its side, so take the larger projection.
    pub fn pitch_along(&self, d: Point) -> f64 {
        (d.x.abs() * self.mh).max(d.y.abs() * self.mv)
    }

    /// Rows that confirmed the mark relative to the ~3 module heights a real one
    /// spans (scanning every row); marks made of data bits rarely repeat that long.
    pub fn coverage(&self) -> f64 {
        self.count as f64 / (3.0 * self.mv).max(1.0)
    }
}

/// Smallest big finder searched for: 7 modules of 2 px.
const MIN_FINDER_PX: u32 = 14;
/// Least gray-level difference between a big finder's centre and its gap ring.
const MIN_CONTRAST: f64 = 12.0;

/// Module size if the five runs (outer, gap, centre, gap, outer) fit 1:1:c:1:1
/// within `tol` modules per unit, `outer` for the two outer runs.
fn ratio(runs: &[u32; 5], center: f64, tol: f64, outer: f64) -> Option<f64> {
    let total: u32 = runs.iter().sum();
    let units = 4.0 + center;
    if (total as f64) < units {
        return None;
    }
    let m = total as f64 / units;
    for (i, &r) in runs.iter().enumerate() {
        let (expect, allowed) = match i {
            2 => (center * m, center * tol * m),
            0 | 4 => (m, outer * m),
            _ => (m, tol * m),
        };
        if (r as f64 - expect).abs() >= allowed {
            return None;
        }
    }
    Some(m)
}

/// Runs through `start` along `d`: (outer, gap, centre, gap, outer) with the
/// centre of color `color`. Returns the continuous position of the centre run's
/// midpoint (in steps from the start pixel's origin) and the module size in steps.
fn cross_check(
    bm: &Bitmap,
    start: (isize, isize),
    d: (isize, isize),
    color: u8,
    max_run: u32,
    tol: f64,
) -> Option<(f64, f64)> {
    let get = |k: isize| bm.get(start.0 + d.0 * k, start.1 + d.1 * k);
    if get(0) != Some(color) {
        return None;
    }
    let other = 1 - color;
    let mut c = [0u32; 5];
    let mut k = 0isize;
    while get(k) == Some(color) {
        c[2] += 1;
        k -= 1;
        if c[2] > 3 * max_run {
            return None;
        }
    }
    while get(k) == Some(other) {
        c[1] += 1;
        k -= 1;
        if c[1] > max_run {
            return None;
        }
    }
    while get(k) == Some(color) {
        c[0] += 1;
        k -= 1;
        if c[0] > max_run {
            return None;
        }
    }
    // The outer ring must be closed by the separator, not cut by the bitmap edge.
    if c[1] == 0 || c[0] == 0 || get(k).is_none() {
        return None;
    }
    let low = k + 1 + (c[0] + c[1]) as isize;
    let mut k = 1isize;
    while get(k) == Some(color) {
        c[2] += 1;
        k += 1;
        if c[2] > 3 * max_run {
            return None;
        }
    }
    let high = k;
    while get(k) == Some(other) {
        c[3] += 1;
        k += 1;
        if c[3] > max_run {
            return None;
        }
    }
    while get(k) == Some(color) {
        c[4] += 1;
        k += 1;
        if c[4] > max_run {
            return None;
        }
    }
    if c[3] == 0 || c[4] == 0 || get(k).is_none() {
        return None;
    }
    // The outer runs get twice the tolerance: their far side faces the separator
    // and whatever lies beyond the grid, where blur and a local-mean threshold
    // move the edge outwards (most at the grid's corners, on the diagonal).
    let m = ratio(&c, 3.0, tol, 2.0 * tol)?;
    Some(((low + high) as f64 / 2.0, m))
}

/// Scans every `step`-th row of the bitmap (made from `img`) for big finders and
/// appends or merges confirmed ones into `out`.
#[allow(clippy::needless_range_loop)] // x runs one past the row as an end sentinel
pub fn scan(img: &GrayImage, bm: &Bitmap, step: usize, out: &mut Vec<Candidate>) {
    let r = bm.rect;
    let w = r.width();
    if w == 0 {
        return;
    }
    for y in (r.y0..r.y1).step_by(step.max(1)) {
        let row = bm.row(y);
        let mut runs = [0u32; 5];
        let mut n = 0usize;
        let mut cur = row[0];
        let mut len = 0u32;
        for x in 0..=w {
            let v = if x < w { row[x] } else { 2 };
            if v == cur {
                len += 1;
                continue;
            }
            runs = [runs[1], runs[2], runs[3], runs[4], len];
            n += 1;
            // Below ~2 px per module the grid cannot be sampled anyway; skipping
            // those patterns also drops the many tiny ones that noise makes.
            if n >= 5 && runs.iter().sum::<u32>() >= MIN_FINDER_PX && ratio(&runs, 3.0, 0.5, 0.5).is_some() {
                let cx = (r.x0 + x) as f64 - runs[4] as f64 - runs[3] as f64 - runs[2] as f64 / 2.0;
                let total: u32 = runs.iter().sum();
                confirm(img, bm, cx, y, cur, total, out);
            }
            cur = v;
            len = 1;
        }
    }
}

fn confirm(img: &GrayImage, bm: &Bitmap, cx: f64, y: usize, color: u8, total: u32, out: &mut Vec<Candidate>) {
    // Vertical extent may differ from horizontal: vt100 cells are twice as tall,
    // and the view may be rotated.
    let max_run = 2 * total;
    let col = cx.floor() as isize;
    let Some((dy, mv)) = cross_check(bm, (col, y as isize), (0, 1), color, max_run, 0.5) else { return };
    let cy = y as f64 + dy;
    // Every row of a mark checks the same centre row, so one row that blur or
    // noise spoils would hide the mark: rows up to a third of a module away
    // cross the centre square just as well.
    let reach = (mv / 3.0) as isize;
    let Some((row, (dx, mh))) = (0..=2 * reach)
        .map(|k| cy.floor() as isize + if k % 2 == 1 { (k + 1) / 2 } else { -(k / 2) })
        .find_map(|row| cross_check(bm, (col, row), (1, 0), color, max_run, 0.5).map(|r| (row, r)))
    else {
        return;
    };
    let cx = col as f64 + dx;
    if !(0.25..=4.0).contains(&(mv / mh)) {
        return;
    }
    // A diagonal through the centre crosses the rings in the same proportions.
    let start = (cx.floor() as isize, row);
    if cross_check(bm, start, (1, 1), color, max_run, 0.75).is_none() {
        return;
    }
    let bright = color == 1;
    // Noise in a flat surround lines such runs up now and then; a mark has real
    // contrast between its centre and the gap ring two modules out.
    let gap = [(2.0 * mh, 0.0), (-2.0 * mh, 0.0), (0.0, 2.0 * mv), (0.0, -2.0 * mv)]
        .iter()
        .map(|&(dx, dy)| img.bilinear(cx + dx, cy + dy))
        .sum::<f64>()
        / 4.0;
    let contrast = img.bilinear(cx, cy) - gap;
    if (if bright { contrast } else { -contrast }) < MIN_CONTRAST {
        return;
    }
    merge(out, Candidate { x: cx, y: cy, mh, mv, bright, count: 1 });
}

/// Adds `k` to `out`, folded into a candidate for the same mark if there is one
/// (weighted by the rows that confirmed each).
pub fn merge(out: &mut Vec<Candidate>, k: Candidate) {
    for c in out.iter_mut() {
        if c.bright == k.bright
            && (c.x - k.x).abs() <= 1.5 * c.mh.max(k.mh)
            && (c.y - k.y).abs() <= 1.5 * c.mv.max(k.mv)
            && (0.5..=2.0).contains(&(c.module() / k.module()))
        {
            let (n, m) = (c.count as f64, k.count as f64);
            c.x = (c.x * n + k.x * m) / (n + m);
            c.y = (c.y * n + k.y * m) / (n + m);
            c.mh = (c.mh * n + k.mh * m) / (n + m);
            c.mv = (c.mv * n + k.mv * m) / (n + m);
            c.count += k.count;
            return;
        }
    }
    out.push(k);
}

/// Three big finders in their roles.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Triple {
    pub tl: Candidate,
    pub tr: Candidate,
    pub bl: Candidate,
}

impl Triple {
    /// Assigns roles: TL is where the angle is closest to 90°, and TR/BL follow
    /// from the sign of the cross product (y points down on screen).
    pub fn arrange(a: Candidate, b: Candidate, c: Candidate) -> (Triple, f64) {
        let cos = |p: &Candidate, q: &Candidate, r: &Candidate| {
            let (u, v) = (q.pos() - p.pos(), r.pos() - p.pos());
            (u.dot(v) / (u.norm() * v.norm()).max(1e-9)).abs()
        };
        let options = [(a, b, c), (b, a, c), (c, a, b)];
        let (tl, p, q) = options
            .into_iter()
            .min_by(|x, y| cos(&x.0, &x.1, &x.2).total_cmp(&cos(&y.0, &y.1, &y.2)))
            .expect("three options");
        let score = cos(&tl, &p, &q);
        let (tr, bl) = if (p.pos() - tl.pos()).cross(q.pos() - tl.pos()) > 0.0 { (p, q) } else { (q, p) };
        (Triple { tl, tr, bl }, score)
    }

    /// Still a plausible grid corner: roughly right-angled, same handedness.
    pub fn is_plausible(&self) -> bool {
        let u = self.tr.pos() - self.tl.pos();
        let v = self.bl.pos() - self.tl.pos();
        let m = self.tl.module().max(1.0);
        u.cross(v) > 0.0 && (u.dot(v) / (u.norm() * v.norm())).abs() < 0.5 && u.norm() > 8.0 * m && v.norm() > 6.0 * m
    }
}

/// The best few triples among `cands`, best first.
pub fn triples(cands: &[Candidate], limit: usize) -> Vec<Triple> {
    let mut scored: Vec<(f64, Triple)> = Vec::new();
    for bright in [true, false] {
        let mut pool: Vec<&Candidate> = cands.iter().filter(|c| c.bright == bright).collect();
        // Prefer marks confirmed by several rows; a real 7-module mark always is.
        if pool.iter().filter(|c| c.count >= 2).count() >= 3 {
            pool.retain(|c| c.count >= 2);
        }
        pool.sort_by_key(|c| std::cmp::Reverse(c.count));
        pool.truncate(10);
        for i in 0..pool.len() {
            for j in i + 1..pool.len() {
                for k in j + 1..pool.len() {
                    let (t, cos) = Triple::arrange(*pool[i], *pool[j], *pool[k]);
                    let sizes = [t.tl.module(), t.tr.module(), t.bl.module()];
                    let max = sizes.iter().copied().fold(f64::MIN, f64::max);
                    let min = sizes.iter().copied().fold(f64::MAX, f64::min);
                    if cos > 0.45 || max / min > 2.2 || !t.is_plausible() {
                        continue;
                    }
                    let coverage = [t.tl, t.tr, t.bl].iter().map(Candidate::coverage).fold(f64::MAX, f64::min);
                    scored.push((cos + 0.3 * (max / min).ln() + (1.0 - coverage.min(1.0)), t));
                }
            }
        }
    }
    scored.sort_by(|a, b| a.0.total_cmp(&b.0));
    scored.into_iter().take(limit).map(|(_, t)| t).collect()
}

/// Known modules around the small finder, as offsets from its centre module:
/// the 5×5 mark, its separator, and the quiet border to the right and below.
fn small_template() -> impl Iterator<Item = (i32, i32, bool)> {
    (-3..=4).flat_map(|dj: i32| {
        (-3..=4).map(move |di: i32| {
            let d = di.abs().max(dj.abs());
            (di, dj, d <= 2 && d != 1)
        })
    })
}

/// Finds the small bottom-right finder near `pred` (its centre), given the image
/// of one module step in x (`ju`) and y (`jv`) there. Template search over
/// ±`radius` modules, then edge refinement along both axes.
pub fn find_small(img: &GrayImage, pred: Point, ju: Point, jv: Point, bright: bool, radius: f64) -> Option<Point> {
    // The mark is 5 modules wide and must be in view; a module step longer than
    // a seventh of the image or a prediction off-image means bad geometry.
    let limit = diagonal(img) / 7.0;
    if !(near_image(img, pred, 0.0) && ju.norm() <= limit && jv.norm() <= limit) {
        return None;
    }
    let template: Vec<(i32, i32, bool)> = small_template().collect();
    let n_fg = template.iter().filter(|t| t.2).count() as f64;
    let n_bg = template.len() as f64 - n_fg;
    let sign = if bright { 1.0 } else { -1.0 };
    let score = |c: Point| -> (f64, f64, f64) {
        let (mut fg, mut bg) = (0.0, 0.0);
        for &(di, dj, on) in &template {
            let p = c + ju * di as f64 + jv * dj as f64;
            let v = img.bilinear(p.x, p.y);
            if on {
                fg += v;
            } else {
                bg += v;
            }
        }
        let (fg, bg) = (fg / n_fg, bg / n_bg);
        (sign * (fg - bg), fg, bg)
    };
    let mut best = (f64::MIN, pred, 0.0, 0.0);
    let steps = (radius * 3.0).ceil() as i32;
    for b in -steps..=steps {
        for a in -steps..=steps {
            let c = pred + ju * (a as f64 / 3.0) + jv * (b as f64 / 3.0);
            let (s, fg, bg) = score(c);
            if s > best.0 {
                best = (s, c, fg, bg);
            }
        }
    }
    let (s, peak, fg, bg) = best;
    // A real mark has strong contrast between its expected light and dark modules.
    if s < 0.35 * (fg - bg).abs().max(1.0) || s < 12.0 {
        return None;
    }
    let threshold = (fg + bg) / 2.0;
    // Refine: the six ring edges along each axis sit at ±0.5, ±1.5, ±2.5 modules.
    let edges = || {
        let mut c = peak;
        for _ in 0..2 {
            let du = refine_axis(img, c, ju, jv, threshold)?;
            let dv = refine_axis(img, c, jv, ju, threshold)?;
            c = c + ju * du + jv * dv;
            if du.abs() < 0.02 && dv.abs() < 0.02 {
                break;
            }
        }
        Some(c)
    };
    // Blur can merge the 1-module rings; the template peak stays centred (a
    // symmetric mark under a symmetric blur), so search it in twelfths of a module.
    let fine = || {
        let offsets = (-4..=4).flat_map(|b| (-4..=4).map(move |a| (a, b)));
        let at = |(a, b): (i32, i32)| peak + ju * (a as f64 / 12.0) + jv * (b as f64 / 12.0);
        offsets.map(at).max_by(|p, q| score(*p).0.total_cmp(&score(*q).0)).unwrap_or(peak)
    };
    Some(edges().unwrap_or_else(fine))
}

/// Offset (in modules along `axis`) of the small finder's centre from `c`.
fn refine_axis(img: &GrayImage, c: Point, axis: Point, across: Point, threshold: f64) -> Option<f64> {
    let len = axis.norm();
    if !(len >= 1.0 && len <= diagonal(img) / 7.0 && near_image(img, c, 0.0)) {
        return None;
    }
    let dir = axis * (1.0 / len);
    let half_width = across.norm() * 0.2;
    let step = (len / 6.0).min(1.0);
    let p = Profile::sample(img, c, dir, -3.1 * len, 3.1 * len, step, half_width, across.unit());
    let edges = p.edges_fixed(threshold, 0.4 * len / step);
    let expected = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
    let mut sum = 0.0;
    for e in expected {
        let target = e * len;
        let near = edges.iter().copied().min_by(|a, b| (a - target).abs().total_cmp(&(b - target).abs()))?;
        if (near - target).abs() > 0.45 * len {
            return None;
        }
        sum += near - target;
    }
    Some(sum / expected.len() as f64 / len)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(x: f64, y: f64) -> Candidate {
        Candidate { x, y, mh: 5.0, mv: 5.0, bright: true, count: 5 }
    }

    #[test]
    fn roles_follow_geometry() {
        let (tl, tr, bl) = (cand(100.0, 100.0), cand(900.0, 120.0), cand(90.0, 500.0));
        for (a, b, c) in [(tl, tr, bl), (bl, tl, tr), (tr, bl, tl)] {
            let (t, _) = Triple::arrange(a, b, c);
            assert_eq!((t.tl, t.tr, t.bl), (tl, tr, bl));
        }
        // Rotated by 90° (phone held sideways): the roles rotate with it.
        let (tl, tr, bl) = (cand(500.0, 100.0), cand(500.0, 900.0), cand(100.0, 100.0));
        let (t, _) = Triple::arrange(bl, tr, tl);
        assert_eq!((t.tl, t.tr, t.bl), (tl, tr, bl));
    }

    #[test]
    fn ratio_check() {
        assert!(ratio(&[5, 5, 15, 5, 5], 3.0, 0.5, 0.5).is_some());
        assert!(ratio(&[5, 5, 5, 5, 5], 3.0, 0.5, 0.5).is_none());
        assert!(ratio(&[5, 5, 5, 5, 5], 1.0, 0.5, 0.5).is_some());
        assert!(ratio(&[9, 5, 15, 5, 5], 3.0, 0.5, 0.5).is_none());
        assert!(ratio(&[9, 5, 15, 5, 5], 3.0, 0.5, 1.0).is_some());
    }
}
