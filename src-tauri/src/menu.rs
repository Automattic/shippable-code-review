// App-level menu. The Edit→Find and View→Zoom items don't *do* anything in
// Rust — they emit `shippable:menu` events that the React app listens for, so
// the find bar and zoom logic stay in the frontend where they belong.
//
// We still build the rest of the macOS-standard menu (Copy/Paste/Quit/etc.)
// explicitly because setting an app menu replaces the system default, and
// without these macOS users lose ⌘C/⌘V/⌘Q via the menu.

use tauri::menu::{AboutMetadataBuilder, Menu, MenuId, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_window = MenuItemBuilder::with_id("shippable:new-window", "New Window")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let register_mcp =
        MenuItemBuilder::with_id("shippable:register-mcp", "Register MCP…").build(app)?;
    let find = MenuItemBuilder::with_id("shippable:find", "Find")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id("shippable:zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+Plus")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("shippable:zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("shippable:zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let detach_sidebar = MenuItemBuilder::with_id("shippable:detach-sidebar", "Detach Sidebar")
        .accelerator("CmdOrCtrl+Shift+[")
        .build(app)?;
    let detach_inspector =
        MenuItemBuilder::with_id("shippable:detach-inspector", "Detach Inspector")
            .accelerator("CmdOrCtrl+Shift+]")
            .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Shippable")
        .about(Some(AboutMetadataBuilder::new().build()))
        .separator()
        .item(&register_mcp)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&detach_sidebar)
        .item(&detach_inspector)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

/// Maps a menu item id to the action string we emit to the frontend.
/// Returning None for unknown ids keeps the event handler a no-op for the
/// predefined items (which already do their work natively).
pub fn action_for(id: &MenuId) -> Option<&'static str> {
    match id.as_ref() {
        "shippable:find" => Some("find"),
        "shippable:zoom-in" => Some("zoom-in"),
        "shippable:zoom-out" => Some("zoom-out"),
        "shippable:zoom-reset" => Some("zoom-reset"),
        "shippable:new-window" => Some("new-window"),
        "shippable:register-mcp" => Some("register-mcp"),
        "shippable:detach-sidebar" => Some("detach-sidebar"),
        "shippable:detach-inspector" => Some("detach-inspector"),
        _ => None,
    }
}
