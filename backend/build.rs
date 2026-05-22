fn main() {
    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/streamcheats_app_icon.ico");
        // Embed sensible product info so Windows Explorer's tooltip
        // and the file-properties dialog have real strings instead
        // of "0.0.0.0 / Windows host process".
        res.set("ProductName", "StreamCheats Core");
        res.set("FileDescription", "StreamCheats Core");
        res.set("CompanyName", "Sunshine Systems");
        res.set("LegalCopyright", "");
        if let Err(e) = res.compile() {
            eprintln!("winres compile failed: {}", e);
            std::process::exit(1);
        }
    }
}
