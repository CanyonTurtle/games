{
  description = "Bevy game development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Rust toolchain
            rustc
            cargo
            rust-analyzer
            
            # LLVM/Clang toolchain for linking
            clang
            lld
            
            # Additional tools that might be useful for Bevy development
            pkg-config
            udev
            alsa-lib
            vulkan-loader
            xorg.libX11
            xorg.libXcursor
            xorg.libXrandr
            xorg.libXi
            xorg.libXext
            xorg.libXxf86vm
            xorg.libXinerama
            libxkbcommon
            libGL
            
            # Optional: for better development experience
            rustfmt
            clippy
          ];

          # Set environment variables for Bevy
          shellHook = ''
            export RUST_BACKTRACE=1
            export CARGO_TARGET_DIR=target
            export PKG_CONFIG_PATH="${pkgs.udev}/lib/pkgconfig:${pkgs.alsa-lib}/lib/pkgconfig:${pkgs.vulkan-loader}/lib/pkgconfig"
            
            # Help with linking on Linux
            export LD_LIBRARY_PATH="${pkgs.vulkan-loader}/lib:${pkgs.alsa-lib}/lib:${pkgs.udev}/lib:${pkgs.libxkbcommon}/lib:${pkgs.xorg.libX11}/lib:${pkgs.xorg.libXext}/lib:${pkgs.xorg.libXxf86vm}/lib:${pkgs.xorg.libXinerama}/lib"
            
            echo "Bevy development environment ready!"
            echo "Available tools:"
            echo "  - rustc: $(rustc --version)"
            echo "  - cargo: $(cargo --version)"
            echo "  - clang: $(clang --version | head -n1)"
            echo "  - lld: $(lld --version)"
          '';
        };
      });
}
