//! Points and projective maps.

use std::ops::{Add, Mul, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    pub fn dot(self, o: Point) -> f64 {
        self.x * o.x + self.y * o.y
    }

    /// z component of the 2-D cross product.
    pub fn cross(self, o: Point) -> f64 {
        self.x * o.y - self.y * o.x
    }

    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }

    pub fn dist(self, o: Point) -> f64 {
        (self - o).norm()
    }

    /// Unit vector in the same direction (zero stays zero).
    pub fn unit(self) -> Point {
        let n = self.norm();
        if n > 0.0 {
            self * (1.0 / n)
        } else {
            self
        }
    }

    /// The vector turned 90° (clockwise on screen, where y points down).
    pub fn perp(self) -> Point {
        Point::new(-self.y, self.x)
    }
}

impl Add for Point {
    type Output = Point;
    fn add(self, o: Point) -> Point {
        Point::new(self.x + o.x, self.y + o.y)
    }
}

impl Sub for Point {
    type Output = Point;
    fn sub(self, o: Point) -> Point {
        Point::new(self.x - o.x, self.y - o.y)
    }
}

impl Mul<f64> for Point {
    type Output = Point;
    fn mul(self, k: f64) -> Point {
        Point::new(self.x * k, self.y * k)
    }
}

/// A 3×3 projective map, row-major, applied to (x, y, 1). In a [`crate::Detection`]
/// it maps module coordinates (module (x, y) covers [x, x+1) × [y, y+1)) to image pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Homography(pub [f64; 9]);

impl Homography {
    pub const IDENTITY: Homography = Homography([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

    pub fn apply(&self, x: f64, y: f64) -> Point {
        let m = &self.0;
        let w = m[6] * x + m[7] * y + m[8];
        Point::new((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w)
    }

    pub fn map(&self, p: Point) -> Point {
        self.apply(p.x, p.y)
    }

    /// `self ∘ other`: first `other`, then `self`.
    pub fn compose(&self, other: &Homography) -> Homography {
        let (a, b) = (&self.0, &other.0);
        let mut m = [0.0; 9];
        for r in 0..3 {
            for c in 0..3 {
                m[r * 3 + c] = (0..3).map(|k| a[r * 3 + k] * b[k * 3 + c]).sum();
            }
        }
        Homography(m)
    }

    pub fn inverse(&self) -> Option<Homography> {
        let m = &self.0;
        let c = [
            m[4] * m[8] - m[5] * m[7],
            m[2] * m[7] - m[1] * m[8],
            m[1] * m[5] - m[2] * m[4],
            m[5] * m[6] - m[3] * m[8],
            m[0] * m[8] - m[2] * m[6],
            m[2] * m[3] - m[0] * m[5],
            m[3] * m[7] - m[4] * m[6],
            m[1] * m[6] - m[0] * m[7],
            m[0] * m[4] - m[1] * m[3],
        ];
        let det = m[0] * c[0] + m[1] * c[3] + m[2] * c[6];
        if !det.is_finite() || det.abs() < 1e-12 {
            return None;
        }
        Some(Homography(c.map(|v| v / det)))
    }

    /// The map taking the unit square (0,0), (1,0), (1,1), (0,1) to `q[0..4]` (Heckbert).
    pub fn square_to_quad(q: [Point; 4]) -> Option<Homography> {
        let [p0, p1, p2, p3] = q;
        let d1 = p1 - p2;
        let d2 = p3 - p2;
        let d3 = p0 - p1 + p2 - p3;
        let (g, h) = if d3.x.abs() < 1e-12 && d3.y.abs() < 1e-12 {
            (0.0, 0.0)
        } else {
            let den = d1.cross(d2);
            if den.abs() < 1e-12 {
                return None;
            }
            (d3.cross(d2) / den, d1.cross(d3) / den)
        };
        let m = [
            p1.x - p0.x + g * p1.x,
            p3.x - p0.x + h * p3.x,
            p0.x,
            p1.y - p0.y + g * p1.y,
            p3.y - p0.y + h * p3.y,
            p0.y,
            g,
            h,
            1.0,
        ];
        m.iter().all(|v| v.is_finite()).then_some(Homography(m))
    }

    /// The map taking `src[i]` to `dst[i]` for four points in general position.
    pub fn from_quads(src: [Point; 4], dst: [Point; 4]) -> Option<Homography> {
        let s = Homography::square_to_quad(src)?.inverse()?;
        Some(Homography::square_to_quad(dst)?.compose(&s))
    }

    /// The image of a unit step in x and in y at (x, y).
    pub fn jacobian(&self, x: f64, y: f64) -> (Point, Point) {
        let m = &self.0;
        let w = m[6] * x + m[7] * y + m[8];
        let nx = m[0] * x + m[1] * y + m[2];
        let ny = m[3] * x + m[4] * y + m[5];
        let w2 = w * w;
        (
            Point::new((m[0] * w - nx * m[6]) / w2, (m[3] * w - ny * m[6]) / w2),
            Point::new((m[1] * w - nx * m[7]) / w2, (m[4] * w - ny * m[7]) / w2),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quads_round_trip() {
        let src = [Point::new(5.5, 5.5), Point::new(193.5, 5.5), Point::new(194.5, 101.5), Point::new(5.5, 100.5)];
        let dst =
            [Point::new(300.0, 200.0), Point::new(1500.0, 260.0), Point::new(1480.0, 900.0), Point::new(280.0, 950.0)];
        let h = Homography::from_quads(src, dst).unwrap();
        for i in 0..4 {
            assert!(h.map(src[i]).dist(dst[i]) < 1e-6);
        }
        let inv = h.inverse().unwrap();
        let p = Point::new(77.0, 33.0);
        assert!(inv.map(h.map(p)).dist(p) < 1e-6);
        let (dx, dy) = h.jacobian(p.x, p.y);
        let num_dx = h.apply(p.x + 1e-4, p.y) - h.map(p);
        let num_dy = h.apply(p.x, p.y + 1e-4) - h.map(p);
        assert!((dx * 1e-4).dist(num_dx) < 1e-6 && (dy * 1e-4).dist(num_dy) < 1e-6);
    }
}
