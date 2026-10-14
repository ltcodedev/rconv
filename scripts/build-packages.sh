#!/usr/bin/env bash
set -e

VERSION="1.2.0"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${PROJECT_ROOT}/dist-packages"
RELEASE_BIN="${PROJECT_ROOT}/gui/target/release/rconv-gui"

echo "=== [1/6] Preparando ambiente e binário ==="
if [ ! -f "$RELEASE_BIN" ]; then
    echo "Compilando binário release..."
    cargo build --release --manifest-path "${PROJECT_ROOT}/gui/Cargo.toml"
fi

mkdir -p "$DIST_DIR"
cd "$PROJECT_ROOT"

# Strip do binário se ainda não foi feito
strip "$RELEASE_BIN" 2>/dev/null || true

# --- 1. Tarball Binário (.tar.gz) ---
echo "=== [2/6] Gerando Tarball Binário (.tar.gz) ==="
TAR_STAGE=$(mktemp -d)
mkdir -p "$TAR_STAGE/rconv-gui"
cp "$RELEASE_BIN" "$TAR_STAGE/rconv-gui/rconv-gui"
cp "${PROJECT_ROOT}/packaging/rconv-gui.desktop" "$TAR_STAGE/rconv-gui/"
cp "${PROJECT_ROOT}/packaging/rconv-gui.svg" "$TAR_STAGE/rconv-gui/"
tar -czvf "${DIST_DIR}/rconv-gui-linux-x86_64.tar.gz" -C "$TAR_STAGE" rconv-gui
rm -rf "$TAR_STAGE"

# --- 2. Debian (.deb) ---
echo "=== [3/6] Gerando pacote Debian (.deb) ==="
DEB_STAGE=$(mktemp -d)
mkdir -p "$DEB_STAGE/usr/bin"
mkdir -p "$DEB_STAGE/usr/share/applications"
mkdir -p "$DEB_STAGE/usr/share/icons/hicolor/scalable/apps"
mkdir -p "$DEB_STAGE/DEBIAN"

cp "$RELEASE_BIN" "$DEB_STAGE/usr/bin/rconv-gui"
chmod 755 "$DEB_STAGE/usr/bin/rconv-gui"
cp "${PROJECT_ROOT}/packaging/rconv-gui.desktop" "$DEB_STAGE/usr/share/applications/"
cp "${PROJECT_ROOT}/packaging/rconv-gui.svg" "$DEB_STAGE/usr/share/icons/hicolor/scalable/apps/"

cat << EOF > "$DEB_STAGE/DEBIAN/control"
Package: rconv-gui
Version: ${VERSION}
Section: video
Priority: optional
Architecture: amd64
Depends: ffmpeg, fontconfig, libx11-6, libxkbcommon0
Recommends: yt-dlp
Maintainer: Lucas Tiago <eulucastiago@outlook.com>
Homepage: https://github.com/ltcodedev/rconv
Description: Interface grafica moderna para conversao de videos para DaVinci Resolve
 rconv-gui e uma interface grafica nativa em Rust/Slint que converte videos
 para MOV compativel com DaVinci Resolve com audio PCM, download da web
 e sincronizacao de audio por onda.
EOF

# Gera o .deb nativamente via ar/tar ou dpkg-deb se disponível
if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb --build "$DEB_STAGE" "${DIST_DIR}/rconv-gui_${VERSION}_amd64.deb"
else
    # Construção manual conforme especificação Debian (.deb é ar archive)
    echo "2.0" > "$DEB_STAGE/debian-binary"
    tar --numeric-owner --owner=0 --group=0 -czvf "$DEB_STAGE/control.tar.gz" -C "$DEB_STAGE/DEBIAN" .
    tar --numeric-owner --owner=0 --group=0 -czvf "$DEB_STAGE/data.tar.gz" -C "$DEB_STAGE" usr
    ar rc "${DIST_DIR}/rconv-gui_${VERSION}_amd64.deb" \
        "$DEB_STAGE/debian-binary" \
        "$DEB_STAGE/control.tar.gz" \
        "$DEB_STAGE/data.tar.gz"
fi
rm -rf "$DEB_STAGE"

# --- 3. Red Hat / Fedora (.rpm) ---
echo "=== [4/6] Gerando pacote RPM (.rpm) ==="
RPM_STAGE=$(mktemp -d)
mkdir -p "$RPM_STAGE"/{BUILD,RPMS,SOURCES,SPECS,SRPMS,BUILDROOT,db}
cat << EOF > "$RPM_STAGE/SPECS/rconv-gui.spec"
Name:           rconv-gui
Version:        ${VERSION}
Release:        1%{?dist}
Summary:        Conversor moderno de video para DaVinci Resolve
License:        MIT
URL:            https://github.com/ltcodedev/rconv
AutoReqProv:    no

%description
Interface grafica nativa em Rust/Slint para conversao de videos para DaVinci Resolve.

%install
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/scalable/apps

install -m 755 "${RELEASE_BIN}" %{buildroot}%{_bindir}/rconv-gui
install -m 644 "${PROJECT_ROOT}/packaging/rconv-gui.desktop" %{buildroot}%{_datadir}/applications/rconv-gui.desktop
install -m 644 "${PROJECT_ROOT}/packaging/rconv-gui.svg" %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/rconv-gui.svg

%files
%{_bindir}/rconv-gui
%{_datadir}/applications/rconv-gui.desktop
%{_datadir}/icons/hicolor/scalable/apps/rconv-gui.svg
EOF

if command -v rpmbuild >/dev/null 2>&1; then
    rpmbuild --define "_topdir $RPM_STAGE" --define "_dbpath $RPM_STAGE/db" -bb "$RPM_STAGE/SPECS/rconv-gui.spec" 2>/dev/null || true
    find "$RPM_STAGE/RPMS" -name "*.rpm" -exec cp {} "${DIST_DIR}/rconv-gui-${VERSION}-1.x86_64.rpm" \; 2>/dev/null || true
fi
rm -rf "$RPM_STAGE"

# --- 4. Arch Linux (.pkg.tar.zst) ---
echo "=== [5/6] Gerando pacote Arch Linux (.pkg.tar.zst) ==="
ARCH_STAGE=$(mktemp -d)
mkdir -p "$ARCH_STAGE"
cat << EOF > "$ARCH_STAGE/PKGBUILD"
pkgname=rconv-gui-bin
pkgver=${VERSION}
pkgrel=1
pkgdesc="Native Rust/Slint GUI for DaVinci Resolve conversion"
arch=('x86_64')
url="https://github.com/ltcodedev/rconv"
license=('MIT')
depends=('ffmpeg' 'fontconfig' 'libx11' 'libxkbcommon' 'libglvnd')
optdepends=('yt-dlp: direct web video download support')
provides=('rconv-gui')
conflicts=('rconv-gui')

package() {
    install -Dm755 "${RELEASE_BIN}" "\${pkgdir}/usr/bin/rconv-gui"
    install -Dm644 "${PROJECT_ROOT}/packaging/rconv-gui.desktop" "\${pkgdir}/usr/share/applications/rconv-gui.desktop"
    install -Dm644 "${PROJECT_ROOT}/packaging/rconv-gui.svg" "\${pkgdir}/usr/share/icons/hicolor/scalable/apps/rconv-gui.svg"
}
EOF

if command -v makepkg >/dev/null 2>&1; then
    (cd "$ARCH_STAGE" && PKGDEST="$DIST_DIR" makepkg -f --nodeps) 2>/dev/null || true
    # Se gerou .tar sem zst, compacta com zstd
    for f in "$DIST_DIR"/*pkg.tar; do
        if [ -f "$f" ]; then
            zstd -z --rm "$f" -o "${f}.zst"
        fi
    done
fi
rm -rf "$ARCH_STAGE"

# --- 5. AppImage ---
echo "=== [6/6] Gerando AppImage (.AppImage) ==="
APPDIR=$(mktemp -d)
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/share/icons/hicolor/scalable/apps"

cp "$RELEASE_BIN" "$APPDIR/usr/bin/rconv-gui"
chmod 755 "$APPDIR/usr/bin/rconv-gui"
cp "${PROJECT_ROOT}/packaging/rconv-gui.desktop" "$APPDIR/rconv-gui.desktop"
cp "${PROJECT_ROOT}/packaging/rconv-gui.svg" "$APPDIR/rconv-gui.svg"
cp "${PROJECT_ROOT}/packaging/rconv-gui.svg" "$APPDIR/.DirIcon"
cp "${PROJECT_ROOT}/packaging/rconv-gui.svg" "$APPDIR/usr/share/icons/hicolor/scalable/apps/rconv-gui.svg"

cat << 'EOF' > "$APPDIR/AppRun"
#!/bin/sh
SELF=$(readlink -f "$0")
HERE=${SELF%/*}
export PATH="${HERE}/usr/bin:${PATH}"
exec "${HERE}/usr/bin/rconv-gui" "$@"
EOF
chmod 755 "$APPDIR/AppRun"

APPIMAGETOOL_BIN="/tmp/appimagetool-x86_64.AppImage"
if [ ! -f "$APPIMAGETOOL_BIN" ]; then
    echo "Baixando appimagetool..."
    curl -sL https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage -o "$APPIMAGETOOL_BIN"
    chmod +x "$APPIMAGETOOL_BIN"
fi

ARCH=x86_64 "$APPIMAGETOOL_BIN" --appimage-extract-and-run "$APPDIR" "${DIST_DIR}/rconv-gui-${VERSION}-x86_64.AppImage" || true
rm -rf "$APPDIR"

echo ""
echo "=========================================="
echo " Pacotes gerados com sucesso em dist-packages:"
ls -lh "$DIST_DIR"
echo "=========================================="
