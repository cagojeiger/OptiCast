//! Times `Vision::process` on simulated camera frames (run with `--release`):
//!
//!     cargo run --release -p diodecam-vision --example bench
//!
//! Reports full search (fresh `Vision` each frame), tracking (one `Vision`
//! across frames), reacquisition (the view turns half a circle every frame, so
//! tracking fails and the search runs right after a detection) and an empty
//! view (no grid) for 1920×1080 and 1280×720 views of a 200x55 terminal and a
//! portrait 1080×1920 view of a 120x40 one.

use std::time::Instant;

use diodecam_core::{frame, Layout, Profile, SendOptions, Transfer};
use diodecam_sim::{view, Camera, Rng, Terminal};
use diodecam_vision::Vision;

fn print(w: usize, h: usize, label: &str, mut times: Vec<f64>, found: usize) {
    times.sort_by(f64::total_cmp);
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    println!(
        "{w}x{h} {label:12} mean {mean:6.2} ms  median {:6.2}  p95 {:6.2}  found {found}/{}",
        times[times.len() / 2],
        times[times.len() * 95 / 100],
        times.len()
    );
}

fn main() {
    for ((w, h), (cols, rows)) in [((1920, 1080), (200, 55)), ((1280, 720), (200, 55)), ((1080, 1920), (120, 40))] {
        let layout = Layout::for_terminal(Profile::Ssh, cols, rows).unwrap();
        let mut tx = Transfer::prepare(&Rng::new(7).bytes(300_000), "b", SendOptions { compress: false }, 1).unwrap();
        let term = Terminal { line_gap: 2, ..Terminal::new(cols, rows) };
        let shots = |roll: [f64; 2], tx: &mut Transfer| -> Vec<_> {
            (0..20)
                .map(|i| {
                    let screen = term.rasterize(&frame::render(&layout, &tx.next_frame(&layout)));
                    let aspect = screen.width as f64 / screen.height as f64;
                    let corners = view(w, h, aspect, 0.85, 8.0, 4.0, roll[i as usize % 2]);
                    Camera { blur: 1, noise: 8.0, levels: (30.0, 220.0), seed: i, ..Camera::new(w, h, corners) }
                        .shoot(&screen)
                })
                .collect()
        };
        let steady = shots([2.0, 2.0], &mut tx);
        let turning = shots([2.0, 182.0], &mut tx);
        let mut vision = Vision::new();
        for (label, fresh, shots) in
            [("full search", true, &steady), ("tracking", false, &steady), ("reacquire", false, &turning)]
        {
            let (mut times, mut found) = (Vec::new(), 0);
            for _ in 0..5 {
                for s in shots {
                    if fresh {
                        vision.reset();
                    }
                    let t = Instant::now();
                    let d = vision.process(&s.data, s.width, s.height);
                    times.push(t.elapsed().as_secs_f64() * 1000.0);
                    found += d.is_some() as usize;
                }
            }
            print(w, h, label, times, found);
        }
        // Nothing on screen but a desk, right after a detection.
        let empty = Camera { noise: 8.0, seed: 99, ..Camera::new(w, h, view(w, h, 1.8, 0.85, 0.0, 0.0, 0.0)) }
            .shoot(&diodecam_sim::Gray::new(1608, 892, 60));
        let times: Vec<f64> = (0..20)
            .map(|_| {
                let t = Instant::now();
                assert!(vision.process(&empty.data, w, h).is_none());
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        print(w, h, "empty view", times, 0);
    }
}
