//! Vision on simulated camera frames of real sender frames (`docs/web.md` §7):
//! tilted and rotated views, blur, noise, both themes, line gaps, two camera
//! resolutions and two terminal sizes; torn captures; tracking; lens correction;
//! and a full transfer through the camera path.

mod common;

use common::*;
use diodecam_core::tile;
use diodecam_core::{frame, Assembler, Profile, SendOptions, Transfer};
use diodecam_sim::{Gray, Rng, Theme};
use diodecam_vision::{Polarity, Vision};

const THEMES: [Theme; 2] = [Theme::DARK, Theme::LIGHT];
const CAMERAS: [(usize, usize); 2] = [(1920, 1080), (1280, 720)];
const TERMINALS: [(usize, usize); 2] = [(200, 55), (120, 40)];

/// Moderate: a hand-held phone a little off-axis, slight defocus, normal sensor noise.
fn moderate() -> Case {
    Case {
        yaw: 8.0,
        pitch: -5.0,
        roll: 3.0,
        blur: 1,
        noise: 8.0,
        line_gap: 2,
        levels: (30.0, 220.0),
        surround: 25,
        ..Case::default()
    }
}

fn matrix(base: Case) -> Vec<(String, Case)> {
    let mut out = Vec::new();
    for (ti, theme) in THEMES.into_iter().enumerate() {
        for camera in CAMERAS {
            for (cols, rows) in TERMINALS {
                let name = format!("{}x{} {} {}p", cols, rows, ["dark", "light"][ti], camera.1);
                out.push((name, Case { theme, camera, cols, rows, seed: out.len() as u64 + 1, ..base }));
            }
        }
    }
    out
}

fn report(name: &str, out: &[Outcome]) {
    let (mer, pass, wrong, det) = summary(out);
    let res: Vec<String> = out.iter().map(|o| format!("{:.2}", o.residual)).collect();
    eprintln!(
        "{name:28} FI {det}/{}  module errors {:.5}  tiles {:5.1}%  wrong {wrong}  tracked {}/{}  residual [{}]",
        out.len(),
        mer,
        pass * 100.0,
        out.iter().filter(|o| o.tracked).count(),
        out.len(),
        res.join(" ")
    );
}

#[test]
fn moderate_conditions_every_theme_size_and_resolution() {
    for (name, case) in matrix(moderate()) {
        let out = film(&case, 4);
        report(&name, &out);
        let (mer, pass, wrong, det) = summary(&out);
        assert_eq!(det, out.len(), "{name}: FI must decode in every frame");
        assert!(mer < 1e-3, "{name}: module error rate {mer}");
        assert!(pass >= 0.95, "{name}: tile pass rate {pass}");
        assert_eq!(wrong, 0, "{name}");
        assert!(out[1..].iter().all(|o| o.tracked), "{name}: frames after the first are tracked");
    }
}

/// Blur radius 2 (a 5 px box), σ = 16 noise, 3 px line gap, glare, and a 12°
/// turn. Where modules stay wider than the blur this still decodes; 200x55 at
/// 720p tilted has 4.6–5.5 px modules, under the blur width, and is only
/// required to never produce a wrong tile (head-on it decodes, see below).
#[test]
fn harsh_conditions_degrade_gracefully() {
    let harsh = Case {
        yaw: 12.0,
        pitch: 6.0,
        roll: 3.0,
        blur: 2,
        noise: 16.0,
        line_gap: 3,
        levels: (40.0, 210.0),
        surround: 35,
        ..Case::default()
    };
    let mut all = Vec::new();
    for (name, case) in matrix(harsh) {
        let out = film(&case, 4);
        report(&format!("harsh {name}"), &out);
        let (_, pass, wrong, det) = summary(&out);
        assert_eq!(wrong, 0, "{name}");
        if case.cols == 200 && case.camera.1 == 720 {
            continue;
        }
        assert!(det >= 3, "{name}: FI decoded in {det}/4 frames");
        assert!(pass >= 0.75, "{name}: tile pass rate {pass}");
        all.extend(out);
    }
    let (_, pass, _, _) = summary(&all);
    assert!(pass >= 0.9, "overall harsh pass rate {pass}");
    for theme in THEMES {
        let head_on = Case { camera: (1280, 720), theme, yaw: 0.0, pitch: 0.0, roll: 1.0, ..harsh };
        let out = film(&head_on, 4);
        report(&format!("harsh 200x55 {theme:?} 720p head-on"), &out);
        let (_, pass, wrong, det) = summary(&out);
        assert!(det >= 3 && pass >= 0.75 && wrong == 0, "head-on 720p: {det} {pass} {wrong}");
    }
}

/// A box blur wider than a module merges the 1-module timing modules (their
/// edges cannot be counted) and smears the finders' rings: 4.2 px modules
/// under a 5 px box, 5.8 px under a 7 px one. The finders, the phase of the
/// timing lines and the blur-aware threshold still read every frame.
#[test]
fn blur_wider_than_a_module() {
    for (name, fill, blur) in [("4.2 px modules, blur 2", 0.27, 2), ("5.8 px modules, blur 3", 0.37, 3)] {
        let case = Case {
            cols: 120,
            rows: 40,
            fill,
            blur,
            noise: 6.0,
            line_gap: 2,
            levels: (30.0, 220.0),
            yaw: 4.0,
            pitch: -3.0,
            roll: 2.0,
            ..Case::default()
        };
        let out = film(&case, 4);
        report(name, &out);
        let (_, pass, wrong, det) = summary(&out);
        assert!(det == 4 && pass >= 0.95 && wrong == 0, "{name}: FI {det}/4, tiles {pass}, wrong {wrong}");
    }
}

#[test]
fn perspective_and_rotation() {
    let base = moderate();
    let cases = [
        ("yaw 20", Case { yaw: 20.0, ..base }),
        ("pitch 20", Case { pitch: 20.0, yaw: 0.0, ..base }),
        // Turned towards the left/top corner, which comes closer: frame it smaller.
        ("yaw -18 pitch 12", Case { yaw: -18.0, pitch: 12.0, fill: 0.7, ..base }),
        ("roll 10", Case { roll: 10.0, fill: 0.75, ..base }),
        ("roll 45", Case { roll: 45.0, fill: 0.42, ..base }),
        ("roll 90 (phone sideways)", Case { roll: 90.0, fill: 0.5, ..base }),
        ("roll 180 (upside down)", Case { roll: 180.0, ..base }),
        ("120x40 close-up", Case { cols: 120, rows: 40, fill: 0.95, ..base }),
        ("720p far (3.5 px modules)", Case { camera: (1280, 720), fill: 0.55, blur: 0, ..base }),
        // Small modules need the small-window pass, which the first frame must run too.
        ("1080p far (3.3 px modules)", Case { camera: (1920, 1080), cols: 120, rows: 40, fill: 0.25, blur: 0, ..base }),
    ];
    for (name, case) in cases {
        let out = film(&case, 4);
        report(name, &out);
        // The first frame must decode: the full search runs every pass on its first miss.
        let first = out.iter().position(|o| o.format_ok).unwrap_or(out.len());
        assert_eq!(first, 0, "{name}: first detection in frame {first}");
        let after = &out[first..];
        let (mer, pass, wrong, det) = summary(after);
        assert_eq!(det, after.len(), "{name}");
        assert!(pass >= 0.95, "{name}: tile pass rate {pass}");
        assert!(mer < 5e-3, "{name}: module error rate {mer}");
        assert_eq!(summary(&out).2 + wrong, 0, "{name}");
    }
}

#[test]
fn vt100_profile_both_themes() {
    for theme in THEMES {
        for camera in CAMERAS {
            let case = Case { profile: Profile::Vt100, theme, camera, ..moderate() };
            let out = film(&case, 3);
            report(&format!("vt100 {:?} {}p", theme, camera.1), &out);
            let (mer, pass, wrong, det) = summary(&out);
            assert_eq!(det, 3);
            assert!(mer < 1e-3 && pass >= 0.95 && wrong == 0, "{mer} {pass} {wrong}");
        }
    }
}

#[test]
fn polarity_follows_the_theme() {
    for (theme, want) in [(Theme::DARK, Polarity::Normal), (Theme::LIGHT, Polarity::Inverted)] {
        let case = Case { theme, ..moderate() };
        let mut sender = Sender::new(&case, 10_000);
        let (grid, _) = sender.next();
        let screen = terminal(&case).rasterize(&grid);
        let shot = camera(&case, &screen, 3).shoot(&screen);
        let d = Vision::new().process(&shot.data, shot.width, shot.height).expect("detected");
        assert_eq!(d.polarity, want);
        assert_eq!(d.format, sender.layout.format());
        // Corners enclose the finders.
        let [tl, _, br, _] = d.corners;
        assert!(tl.x < d.finders[0].x && tl.y < d.finders[0].y && br.x > d.finders[2].x && br.y > d.finders[2].y);
    }
}

/// A capture during a redraw mixes two frames: tiles cut by the boundary must
/// be rejected (RS/CRC), the others decode as the frame they belong to.
#[test]
fn torn_captures_never_yield_wrong_tiles() {
    let mut newer = 0;
    let mut older = 0;
    let mut seed = 0;
    for theme in THEMES {
        for camera in CAMERAS {
            for (cols, rows) in TERMINALS {
                for fraction in [0.15, 0.3, 0.5, 0.62, 0.85] {
                    seed += 1;
                    let case = Case { theme, camera, cols, rows, seed, ..moderate() };
                    let (out, _) = film_torn(&case, fraction);
                    assert_eq!(out.wrong, 0, "{cols}x{rows} {theme:?} {camera:?} torn at {fraction}");
                    older += out.ok_by_frame.first().copied().unwrap_or(0);
                    newer += out.ok_by_frame.get(1).copied().unwrap_or(0);
                }
            }
        }
    }
    eprintln!("torn captures: {older} tiles from the older frame, {newer} from the newer, 0 wrong");
    assert!(older > 100 && newer > 100, "both halves of torn captures still deliver tiles");
}

/// Also when the tear runs through the format information or a finder.
#[test]
fn tears_through_fixed_patterns_are_safe() {
    for fraction in [0.02, 0.05, 0.08, 0.92, 0.95] {
        let case = Case { seed: 40 + (fraction * 100.0) as u64, ..moderate() };
        let (out, _) = film_torn(&case, fraction);
        assert_eq!(out.wrong, 0, "torn at {fraction}");
    }
}

#[test]
fn tracking_follows_a_moving_phone_and_reacquires() {
    let base = moderate();
    let mut sender = Sender::new(&base, 100_000);
    let term = terminal(&base);
    let mut vision = Vision::new();
    let mut tracked = 0;
    for i in 0..12 {
        // The phone drifts: a little turn and roll per frame.
        let case = Case {
            yaw: base.yaw + i as f64 * 0.6,
            roll: base.roll - i as f64 * 0.4,
            fill: 0.85 - i as f64 * 0.01,
            ..base
        };
        let (grid, tiles) = sender.next();
        let screen = term.rasterize(&grid);
        let shot = camera(&case, &screen, 100 + i).shoot(&screen);
        if i == 6 {
            // The view is lost for one frame (pointed away): nothing found, tracking dropped.
            let blank = Gray::new(shot.width, shot.height, 40);
            assert!(vision.process(&blank.data, blank.width, blank.height).is_none());
        }
        let d = vision.process(&shot.data, shot.width, shot.height);
        let o = score(d.as_ref(), &sender.layout, &grid, &[&tiles]);
        assert!(o.format_ok && o.wrong == 0 && o.tiles_ok * 100 >= o.tiles * 95, "frame {i}: {o:?}");
        if i == 6 {
            assert!(!o.tracked, "reacquired by full search after the lost frame");
        }
        tracked += o.tracked as usize;
    }
    assert!(tracked >= 9, "{tracked}/12 frames tracked");
}

#[test]
fn nothing_found_in_frames_without_a_grid() {
    let mut vision = Vision::new();
    let mut rng = Rng::new(9);
    let noise: Vec<u8> = (0..1280 * 720).map(|_| rng.next_u64() as u8).collect();
    assert!(vision.process(&noise, 1280, 720).is_none());
    assert!(vision.process(&vec![128; 1280 * 720], 1280, 720).is_none());
    // A terminal with plain text only, on a fresh search (two empty frames make
    // the next one a skipped one).
    vision.reset();
    let case = moderate();
    let text = diodecam_core::ModuleGrid::new(199, 106);
    let screen = terminal(&case).rasterize(&text);
    let shot = camera(&case, &screen, 1).shoot(&screen);
    assert!(vision.process(&shot.data, shot.width, shot.height).is_none());
    // Tiny images are rejected without panicking.
    assert!(vision.process(&[0; 100], 10, 10).is_none());
}

/// Barrel distortion bends the grid away from any homography; past 0.1 module
/// of timing-line residual the timing-line correction kicks in and fixes most of it.
#[test]
fn lens_distortion_correction() {
    let case = Case { radial: 0.0175, blur: 1, noise: 6.0, ..Case::default() };
    let mut sender = Sender::new(&case, 100_000);
    let term = terminal(&case);
    let (mut with, mut without, mut both, mut corrected) = (0, 0, 0, 0);
    for i in 0..4 {
        let (grid, tiles) = sender.next();
        let screen = term.rasterize(&grid);
        let shot = camera(&case, &screen, 200 + i).shoot(&screen);
        let mut on = Vision::new();
        let mut off = Vision::new();
        off.disable_correction(true);
        let a = score(on.process(&shot.data, shot.width, shot.height).as_ref(), &sender.layout, &grid, &[&tiles]);
        let b = score(off.process(&shot.data, shot.width, shot.height).as_ref(), &sender.layout, &grid, &[&tiles]);
        assert_eq!(a.wrong + b.wrong, 0);
        corrected += a.corrected as usize;
        if a.format_ok && b.format_ok {
            both += 1;
            with += a.module_errors;
            without += b.module_errors;
        }
    }
    eprintln!("lens k1 0.0175: corrected {corrected}/4, module errors with correction {with}, without {without} ({both} frames)");
    assert!(corrected >= 2 && both >= 2, "correction path exercised");
    assert!(with <= without, "correction must not make it worse: {with} vs {without}");
}

/// The whole receive path on camera frames: vision → tiles → assembler → file.
#[test]
fn file_restored_through_the_camera_path() {
    for (camera_size, theme) in [((1280, 720), Theme::DARK), ((1920, 1080), Theme::LIGHT)] {
        let case = Case { camera: camera_size, theme, ..moderate() };
        let data = Rng::new(77).bytes(30_000);
        let mut tx = Transfer::prepare(&data, "photo.jpg", SendOptions::default(), 99).unwrap();
        let layout = diodecam_core::Layout::for_terminal(case.profile, case.cols, case.rows).unwrap();
        let term = terminal(&case);
        let mut vision = Vision::new();
        let mut rx = Assembler::new();
        let mut frames = 0;
        // Join mid-stream.
        for _ in 0..5 {
            tx.next_frame(&layout);
        }
        while !rx.is_complete() {
            let grid = frame::render(&layout, &tx.next_frame(&layout));
            let screen = term.rasterize(&grid);
            let shot = camera(&case, &screen, frames).shoot(&screen);
            if let Some(d) = vision.process(&shot.data, shot.width, shot.height) {
                let l = diodecam_core::Layout::from_format(d.format).unwrap();
                for (n, raw) in frame::read_tiles(&l, &d.grid).iter().enumerate() {
                    if let Ok(t) = tile::decode(raw, n) {
                        rx.accept(&t);
                    }
                }
            }
            frames += 1;
            assert!(frames < 60, "not complete after {frames} frames: {:?}", rx.stats());
        }
        assert_eq!(rx.finalize().unwrap(), data);
        assert_eq!(rx.meta().unwrap().filename, "photo.jpg");
        eprintln!("{camera_size:?} {theme:?}: restored 30 kB in {frames} camera frames");
    }
}
