use tauri::{
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    AppHandle, Manager, PhysicalPosition,
};

fn position_to_xy(pos: &tauri::Position) -> (f64, f64) {
    match pos {
        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
        tauri::Position::Logical(l) => (l.x, l.y),
    }
}

fn size_to_wh(s: &tauri::Size) -> (f64, f64) {
    match s {
        tauri::Size::Physical(p) => (p.width as f64, p.height as f64),
        tauri::Size::Logical(l) => (l.width, l.height),
    }
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .expect("Failed to load tray icon");
    let _tray = TrayIconBuilder::new()
        .icon(tray_icon)
        .icon_as_template(true)
        .tooltip("Voxbridge")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(panel) = app.get_webview_window("panel") {
                    if panel.is_visible().unwrap_or(false) {
                        let _ = panel.hide();
                    } else {
                        let (icon_x, icon_y) = position_to_xy(&rect.position);
                        let (icon_w, icon_h) = size_to_wh(&rect.size);

                        // Center panel under the tray icon
                        let panel_w = 320.0 * panel.scale_factor().unwrap_or(2.0);
                        let panel_x = icon_x + icon_w / 2.0 - panel_w / 2.0;
                        let panel_y = icon_y + icon_h;

                        let _ = panel.set_position(PhysicalPosition::new(
                            panel_x as i32,
                            panel_y as i32,
                        ));
                        let _ = panel.show();
                        let _ = panel.set_focus();
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}
