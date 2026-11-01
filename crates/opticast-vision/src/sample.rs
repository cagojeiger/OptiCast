//! Module sampling (receiver-v2 §2.6): each module centre through the
//! homography, a 3×3 pixel mean there, compared with the mean of the
//! surrounding 7×7 modules (whitened data is half ones, so that mean sits
//! between the two colors).

use opticast_core::ModuleGrid;

use crate::binarize::GrayImage;
use crate::geom::Homography;
use crate::timing::Correction;

/// Threshold window: (2R + 1)² modules.
const R: usize = 3;

/// Reusable buffers.
#[derive(Default)]
pub struct Sampler {
    values: Vec<u32>,
    integral: Vec<u32>,
}

impl Sampler {
    /// Samples a `w`×`h` grid. `bright`: module 1 (foreground) is the lighter color.
    pub fn sample(
        &mut self,
        img: &GrayImage,
        hom: &Homography,
        corr: Option<&Correction>,
        w: usize,
        h: usize,
        bright: bool,
    ) -> ModuleGrid {
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
        let mut grid = ModuleGrid::new(w, h);
        for y in 0..h {
            let (y0, y1) = (y.saturating_sub(R), (y + R + 1).min(h));
            for x in 0..w {
                let (x0, x1) = (x.saturating_sub(R), (x + R + 1).min(w));
                let sum = self.integral[y1 * iw + x1] + self.integral[y0 * iw + x0]
                    - self.integral[y0 * iw + x1]
                    - self.integral[y1 * iw + x0];
                let n = ((x1 - x0) * (y1 - y0)) as u64;
                let lighter = self.values[y * w + x] as u64 * n > sum as u64;
                grid.set(x, y, lighter == bright);
            }
        }
        grid
    }
}
