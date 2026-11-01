//! Local-mean thresholding with an integral image (receiver-v2 §2.2).

/// A grayscale frame borrowed from the caller.
#[derive(Clone, Copy)]
pub struct GrayImage<'a> {
    pub data: &'a [u8],
    pub width: usize,
    pub height: usize,
}

impl GrayImage<'_> {
    pub fn get(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.width + x]
    }

    /// Bilinear sample at a pixel-centre coordinate (pixel (i, j) is centred at (i + 0.5, j + 0.5)).
    /// Positions outside the image are clamped to the border.
    pub fn bilinear(&self, x: f64, y: f64) -> f64 {
        let fx = (x - 0.5).clamp(0.0, (self.width - 1) as f64);
        let fy = (y - 0.5).clamp(0.0, (self.height - 1) as f64);
        let (x0, y0) = (fx as usize, fy as usize);
        let (x1, y1) = ((x0 + 1).min(self.width - 1), (y0 + 1).min(self.height - 1));
        let (ax, ay) = (fx - x0 as f64, fy - y0 as f64);
        let row = |y: usize| self.get(x0, y) as f64 * (1.0 - ax) + self.get(x1, y) as f64 * ax;
        row(y0) * (1.0 - ay) + row(y1) * ay
    }

    /// Sum of the 3×3 pixels around the pixel containing (x, y) (clamped at the border).
    pub fn box3(&self, x: f64, y: f64) -> u32 {
        let cx = (x.floor() as isize).clamp(1, self.width as isize - 2) as usize;
        let cy = (y.floor() as isize).clamp(1, self.height as isize - 2) as usize;
        let mut sum = 0u32;
        for yy in cy - 1..=cy + 1 {
            let row = &self.data[yy * self.width + cx - 1..yy * self.width + cx + 2];
            sum += row[0] as u32 + row[1] as u32 + row[2] as u32;
        }
        sum
    }
}

/// A half-open pixel rectangle.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

impl Rect {
    pub fn width(&self) -> usize {
        self.x1 - self.x0
    }

    pub fn height(&self) -> usize {
        self.y1 - self.y0
    }

    /// The square of half-size `r` around (cx, cy), clipped to a `w`×`h` image.
    pub fn around(cx: f64, cy: f64, r: f64, w: usize, h: usize) -> Rect {
        let clip = |v: f64, max: usize| (v.max(0.0) as usize).min(max);
        Rect { x0: clip(cx - r, w), y0: clip(cy - r, h), x1: clip(cx + r + 1.0, w), y1: clip(cy + r + 1.0, h) }
    }
}

/// One bit per pixel of a rectangle: 1 = brighter than the local mean.
#[derive(Default)]
pub struct Bitmap {
    pub rect: Rect,
    pub bits: Vec<u8>,
}

impl Bitmap {
    /// The bit at image pixel (x, y), or `None` outside the rectangle.
    pub fn get(&self, x: isize, y: isize) -> Option<u8> {
        let r = &self.rect;
        if x < r.x0 as isize || y < r.y0 as isize || x >= r.x1 as isize || y >= r.y1 as isize {
            return None;
        }
        Some(self.bits[(y as usize - r.y0) * r.width() + (x as usize - r.x0)])
    }

    pub fn row(&self, y: usize) -> &[u8] {
        let w = self.rect.width();
        let start = (y - self.rect.y0) * w;
        &self.bits[start..start + w]
    }
}

/// Reusable buffers for [`binarize`].
#[derive(Default)]
pub struct Binarizer {
    integral: Vec<u32>,
    lx: Vec<u32>,
    rx: Vec<u32>,
    l3: Vec<u32>,
    r3: Vec<u32>,
}

impl Binarizer {
    /// Thresholds `rect` of `img` into `out`: a pixel is 1 when it (with `smooth`,
    /// the mean of its 3×3 neighbourhood: noise ÷ 3) exceeds the mean of the
    /// `window`×`window` box around it. Boxes are clipped to the image.
    #[allow(clippy::needless_range_loop)] // one index into five parallel slices
    pub fn binarize(&mut self, img: &GrayImage, rect: Rect, window: usize, smooth: bool, out: &mut Bitmap) {
        let r = window.max(3) / 2;
        let s = smooth as usize;
        // The integral image covers the rectangle grown by r, clipped to the image.
        let ex0 = rect.x0.saturating_sub(r);
        let ey0 = rect.y0.saturating_sub(r);
        let ex1 = (rect.x1 + r).min(img.width);
        let ey1 = (rect.y1 + r).min(img.height);
        let iw = ex1 - ex0 + 1;
        let ih = ey1 - ey0 + 1;
        self.integral.clear();
        self.integral.resize(iw * ih, 0);
        for y in ey0..ey1 {
            let src = &img.data[y * img.width + ex0..y * img.width + ex1];
            let (above, here) = self.integral.split_at_mut((y - ey0 + 1) * iw);
            let above = &above[(y - ey0) * iw..];
            let mut run = 0u32;
            here[0] = 0;
            for (i, &v) in src.iter().enumerate() {
                run += v as u32;
                here[i + 1] = above[i + 1] + run;
            }
        }
        // Window bounds per column, in integral-image coordinates.
        self.lx.clear();
        self.rx.clear();
        self.l3.clear();
        self.r3.clear();
        for x in rect.x0..rect.x1 {
            self.lx.push((x.saturating_sub(r).max(ex0) - ex0) as u32);
            self.rx.push(((x + r + 1).min(ex1) - ex0) as u32);
            self.l3.push((x.saturating_sub(s).max(ex0) - ex0) as u32);
            self.r3.push(((x + s + 1).min(ex1) - ex0) as u32);
        }
        out.rect = rect;
        out.bits.clear();
        out.bits.resize(rect.width() * rect.height(), 0);
        let w = rect.width();
        for y in rect.y0..rect.y1 {
            let ly = y.saturating_sub(r).max(ey0) - ey0;
            let ry = (y + r + 1).min(ey1) - ey0;
            let height = (ry - ly) as u32;
            let top = &self.integral[ly * iw..(ly + 1) * iw];
            let bottom = &self.integral[ry * iw..(ry + 1) * iw];
            let (ly3, ry3) = (y.saturating_sub(s).max(ey0) - ey0, (y + s + 1).min(ey1) - ey0);
            let height3 = (ry3 - ly3) as u32;
            let top3 = &self.integral[ly3 * iw..(ly3 + 1) * iw];
            let bottom3 = &self.integral[ry3 * iw..(ry3 + 1) * iw];
            let dst = &mut out.bits[(y - rect.y0) * w..(y - rect.y0 + 1) * w];
            for i in 0..w {
                let (l, rr) = (self.lx[i] as usize, self.rx[i] as usize);
                // Column sums first: each difference is non-negative.
                let sum = (bottom[rr] - top[rr]) - (bottom[l] - top[l]);
                let area = (rr - l) as u32 * height;
                let (l3, r3) = (self.l3[i] as usize, self.r3[i] as usize);
                let sum3 = (bottom3[r3] - top3[r3]) - (bottom3[l3] - top3[l3]);
                let area3 = (r3 - l3) as u32 * height3;
                dst[i] = (sum3 * area > sum * area3) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_a_direct_window_mean() {
        let (w, h) = (37, 23);
        let data: Vec<u8> = (0..w * h).map(|i| ((i * 7919) % 251) as u8).collect();
        let img = GrayImage { data: &data, width: w, height: h };
        let mut b = Binarizer::default();
        let mut out = Bitmap::default();
        let rect = Rect { x0: 3, y0: 2, x1: 30, y1: 20 };
        b.binarize(&img, rect, 9, true, &mut out);
        for y in rect.y0..rect.y1 {
            for x in rect.x0..rect.x1 {
                let (mut sum, mut n) = (0u32, 0u32);
                for yy in y.saturating_sub(4)..(y + 5).min(h) {
                    for xx in x.saturating_sub(4)..(x + 5).min(w) {
                        sum += img.get(xx, yy) as u32;
                        n += 1;
                    }
                }
                let (mut s3, mut n3) = (0u32, 0u32);
                for yy in y.saturating_sub(1)..(y + 2).min(h) {
                    for xx in x.saturating_sub(1)..(x + 2).min(w) {
                        s3 += img.get(xx, yy) as u32;
                        n3 += 1;
                    }
                }
                let want = (s3 * n > sum * n3) as u8;
                assert_eq!(out.get(x as isize, y as isize), Some(want), "({x},{y})");
            }
        }
        assert_eq!(out.get(2, 5), None);
        // Unsmoothed: the pixel itself against the window mean.
        b.binarize(&img, rect, 9, false, &mut out);
        let (x, y) = (10, 10);
        let sum: u32 =
            (6..15).flat_map(|yy| (6..15).map(move |xx| (xx, yy))).map(|(xx, yy)| img.get(xx, yy) as u32).sum();
        assert_eq!(out.get(x, y), Some((img.get(10, 10) as u32 * 81 > sum) as u8));
    }
}
