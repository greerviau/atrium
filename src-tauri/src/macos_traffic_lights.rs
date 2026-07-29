//! macOS-only vertical centering of the native traffic-light buttons in
//! Atrium's custom title bar.
//!
//! With `titleBarStyle: "Overlay"`, the traffic lights are still real
//! AppKit views laid out by the system, independent of the DOM title bar
//! drawn by `src/lib/shell/TitleBar.svelte`. Tauri's `trafficLightPosition`
//! window config is the only lever over them, and it is not a plain offset:
//! `tao`'s `inset_traffic_lights` resizes the titlebar container to
//! `close_button_height + y`, anchors it to the top of the window, and then
//! sets only each button's `origin.x` — every button keeps the `origin.y`
//! AppKit assigned it inside that container. So the gap above the buttons
//! is `y - button_origin_y`, and centering them in a title bar of height
//! `h` requires
//!
//! ```text
//! y = (h - button_height) / 2 + button_origin_y
//! ```
//!
//! Both `button_height` and `button_origin_y` are AppKit-version-dependent:
//! macOS 26 (Tahoe) reports a 16pt-tall close button where earlier versions
//! reported 14pt. A `y` hardcoded in `tauri.conf.json` is therefore only
//! ever correct on the macOS version it was calibrated against, which is
//! what made the buttons sit 4px low on Tahoe (issue #332) under a value
//! calibrated on an earlier macOS (#307). This module measures the values
//! at startup instead and derives `y` from them, so the cluster is centered
//! on every macOS version rather than on one.
//!
//! The measurement has to happen *before* the main window is built, because
//! `trafficLightPosition` is a window-creation attribute with no runtime
//! setter in Tauri 2.11 — see `position()`'s use of a throwaway probe
//! window, and `main.rs`'s `config_mut()` patch.

use objc2_app_kit::{NSBackingStoreType, NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

/// The height of the DOM title bar, in CSS pixels — mirrors `.title-bar`'s
/// `height` in `src/lib/shell/TitleBar.svelte`, which is the value the
/// traffic lights are centered against. Keep the two in sync; unlike the
/// old hardcoded offset, changing this is all that a title-bar height
/// change requires, since the offset is derived from it.
const TITLE_BAR_HEIGHT: f64 = 38.0;

/// Horizontal inset of the leftmost (close) button, in CSS pixels. Pairs
/// with `.title-bar`'s `padding-left`, which reserves room for the cluster
/// so the project switcher starts clear of it.
const TRAFFIC_LIGHT_X: f64 = 12.0;

/// Fallback vertical offset used when the AppKit measurement below is
/// unavailable (no main thread). Corresponds to macOS 26's 16pt buttons at
/// `origin.y` 6 — wrong by a couple of pixels on other AppKit versions, but
/// only ever reached if the probe itself could not run.
const FALLBACK_Y: f64 = 17.0;

/// Returns the `trafficLightPosition` that vertically centers the native
/// button cluster in a [`TITLE_BAR_HEIGHT`]-tall title bar on the macOS
/// version actually running.
///
/// The geometry is read from a throwaway, never-ordered-front `NSWindow`
/// rather than from Atrium's own window: this must be answered *before* the
/// real window is created, since `trafficLightPosition` only takes effect
/// at window-creation time. A standard titled window is enough, because the
/// two values read here are constants of the AppKit version and do not vary
/// with a window's size, content, or overlay title-bar style.
pub fn position() -> tauri_utils::config::LogicalPosition {
    let y = measure_centered_y().unwrap_or(FALLBACK_Y);
    tauri_utils::config::LogicalPosition {
        x: TRAFFIC_LIGHT_X,
        y,
    }
}

fn measure_centered_y() -> Option<f64> {
    let mtm = MainThreadMarker::new()?;

    // A window must exist for `standardWindowButton:` to return anything;
    // it is never ordered front, and is closed before returning.
    let probe = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            mtm.alloc::<NSWindow>(),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(480.0, 320.0)),
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::Miniaturizable
                | NSWindowStyleMask::Resizable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: an `NSWindow` created programmatically defaults to releasing
    // itself on `close()`, which would leave the `Retained` handle above
    // dangling. Opting out makes the handle the sole owner, as objc2
    // expects.
    unsafe { probe.setReleasedWhenClosed(false) };

    let close = probe.standardWindowButton(NSWindowButton::CloseButton);
    let frame = close.map(|button| button.frame());
    probe.close();

    let frame = frame?;
    Some(centered_y(frame.size.height, frame.origin.y))
}

/// Derives the `trafficLightPosition` y that centers a button of height
/// `button_height`, sitting at `button_origin_y` inside AppKit's titlebar
/// container, within a [`TITLE_BAR_HEIGHT`]-tall title bar.
///
/// Inverts `tao`'s layout (see the module docs): it sizes the container to
/// `button_height + y`, so the gap above the buttons is `y -
/// button_origin_y` and the gap below is `TITLE_BAR_HEIGHT -
/// (button_height + y) + button_origin_y`. Equating the two gives this.
fn centered_y(button_height: f64, button_origin_y: f64) -> f64 {
    (TITLE_BAR_HEIGHT - button_height) / 2.0 + button_origin_y
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gaps `tao`'s layout leaves above and below the button cluster,
    /// for a given `y` — the thing a user actually sees as (un)centered.
    fn gaps(button_height: f64, button_origin_y: f64, y: f64) -> (f64, f64) {
        let above = y - button_origin_y;
        let below = TITLE_BAR_HEIGHT - (button_height + y) + button_origin_y;
        (above, below)
    }

    #[test]
    fn centers_the_cluster_for_any_appkit_metrics() {
        // Spans the metrics AppKit has actually used (14pt buttons through
        // macOS 15, 16pt from macOS 26) plus headroom, since the whole
        // point is not to depend on one version's numbers.
        for button_height in [12, 14, 16, 18, 20] {
            for button_origin_y in [4, 5, 6, 7, 8, 9, 10] {
                let (h, oy) = (f64::from(button_height), f64::from(button_origin_y));
                let (above, below) = gaps(h, oy, centered_y(h, oy));
                assert!(
                    (above - below).abs() < 1e-9,
                    "not centered for height {h}, origin_y {oy}: {above} above vs {below} below"
                );
            }
        }
    }

    /// Regression anchor for issue #332: macOS 26 (Tahoe) reports a 16pt
    /// close button at `origin.y` 6, and the offset hardcoded at the time
    /// (21, calibrated against an earlier AppKit) left the cluster 4px low.
    #[test]
    fn derives_the_measured_tahoe_offset() {
        assert_eq!(centered_y(16.0, 6.0), 17.0);

        let (above, below) = gaps(16.0, 6.0, 21.0);
        assert_eq!((above, below), (15.0, 7.0));
    }
}
