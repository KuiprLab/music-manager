{
  description = "music-manager discord bot";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }: let
    # ── Package (built with node2nix-style fetchNpmDeps) ─────────────────────
    # We use a straightforward approach: copy source, install deps, build.
    mkPackage = pkgs:
      pkgs.buildNpmPackage {
        pname = "music-manager";
        version = "1.0.0";
        src = ./.;

        npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

        # After npm install, run the TypeScript build
        buildPhase = ''
          npm run build
        '';

        installPhase = ''
          mkdir -p $out/lib/music-manager
          cp -r dist $out/lib/music-manager/dist
          cp -r node_modules $out/lib/music-manager/node_modules
          cp package.json $out/lib/music-manager/

          mkdir -p $out/bin
          cat > $out/bin/music-manager <<EOF
          #!/bin/sh
          cd $out/lib/music-manager
          exec ${pkgs.nodejs_22}/bin/node dist/index.js "\$@"
          EOF
          chmod +x $out/bin/music-manager
        '';
      };

    # ── NixOS module ──────────────────────────────────────────────────────────
    nixosModule = {
      config,
      lib,
      pkgs,
      ...
    }: let
      cfg = config.services.music-manager;
      pkg = mkPackage pkgs;
    in {
      options.services.music-manager = {
        enable = lib.mkEnableOption "music-manager Discord bot";

        environmentFile = lib.mkOption {
          type = lib.types.path;
          description = ''
            Path to a file containing environment variables.
            Must define: DISCORD_TOKEN, CLIENT_ID, SLSK_USERNAME, SLSK_PASSWORD.
            Optional: DOWNLOAD_DIR (default: /var/lib/music-manager/downloads).
          '';
          example = "/run/secrets/music-manager.env";
        };

        downloadDir = lib.mkOption {
          type = lib.types.str;
          default = "/var/lib/music-manager/downloads";
          description = "Directory to save downloaded music.";
        };

        user = lib.mkOption {
          type = lib.types.str;
          default = "music-manager";
          description = "User to run the service as.";
        };

        group = lib.mkOption {
          type = lib.types.str;
          default = "music-manager";
          description = "Group to run the service as.";
        };
      };

      config = lib.mkIf cfg.enable {
        users.users.${cfg.user} = {
          isSystemUser = true;
          group = cfg.group;
          home = "/var/lib/music-manager";
          createHome = true;
        };

        users.groups.${cfg.group} = {};

        systemd.services.music-manager = {
          description = "music-manager Discord bot";
          wantedBy = ["multi-user.target"];
          after = ["network-online.target"];
          wants = ["network-online.target"];

          serviceConfig = {
            User = cfg.user;
            Group = cfg.group;
            WorkingDirectory = "/var/lib/music-manager";
            EnvironmentFile = cfg.environmentFile;
            Environment = [
              "DOWNLOAD_DIR=${cfg.downloadDir}"
              "NODE_ENV=production"
            ];
            ExecStart = "${pkg}/bin/music-manager";
            Restart = "on-failure";
            RestartSec = "10s";

            # Hardening
            NoNewPrivileges = true;
            ProtectSystem = "strict";
            ProtectHome = true;
            ReadWritePaths = [
              "/var/lib/music-manager"
              cfg.downloadDir
            ];
            PrivateTmp = true;
          };

          preStart = ''
            mkdir -p ${cfg.downloadDir}
          '';
        };
      };
    };
  in
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      packages.default = mkPackage pkgs;

      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          nodejs_22
          yarn
        ];
      };
    })
    // {
      nixosModules.default = nixosModule;
      # Convenience alias
      nixosModules.music-manager = nixosModule;
    };
}
