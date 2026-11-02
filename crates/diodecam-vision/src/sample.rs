//! Module sampling (`docs/web.md` §7): each module centre through the
//! homography, a 3×3 pixel mean there, compared with the mean of the
//! surrounding 7×7 modules (whitened data is half ones, so that mean sits
//! between the two colors). Blur spreads each module into its neighbours, so
//! the threshold may also move part of the way to the mean of the four
//! neighbours, which takes that back out (a lone 1 among 0s stays above it):
//! of [`SHIFTS`], the one that misreads the fewest of the layout's known modules.

use diodecam_core::{Layout, ModuleGrid};

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
    /// Per module: the 7×7 mean and the mean of the four neighbours.
    means: Vec<(f64, f64)>,
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
        self.means.clear();
        let v = |x: usize, y: usize| self.values[y * w + x] as f64;
        for y in 0..h {
            let (y0, y1) = (y.saturating_sub(R), (y + R + 1).min(h));
            for x in 0..w {
                let (x0, x1) = (x.saturating_sub(R), (x + R + 1).min(w));
                let sum = self.integral[y1 * iw + x1] + self.integral[y0 * iw + x0]
                    - self.integral[y0 * iw + x1]
                    - self.integral[y1 * iw + x0];
                let mean = sum as f64 / ((x1 - x0) * (y1 - y0)) as f64;
                let neighbours = [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)];
                let (mut near, mut n) = (0.0, 0.0);
                for (nx, ny) in neighbours.into_iter().filter(|&(nx, ny)| nx < w && ny < h) {
                    near += v(nx, ny);
                    n += 1.0;
                }
                self.means.push((mean, near / n));
            }
        }
        let bit = |i: usize, shift: f64| {
            let (mean, near) = self.means[i];
            (self.values[i] as f64 > mean + shift * (near - mean)) == bright
        };
        let misread =
            |shift: f64| (0..w * h).filter(|&i| layout.fixed(i % w, i / w).is_some_and(|f| f != bit(i, shift))).count();
        let shift = SHIFTS.into_iter().min_by_key(|&s| misread(s)).unwrap_or(SHIFTS[0]);
        let mut grid = ModuleGrid::new(w, h);
        for i in 0..w * h {
            grid.set_index(i, bit(i, shift));
        }
        grid
    }
}
