Name:           rconv-gui
Version:        1.2.0
Release:        1%{?dist}
Summary:        Native DaVinci Resolve video converter with PCM audio
License:        MIT
URL:            https://github.com/ltcodedev/rconv
Source0:        rconv-gui-linux-x86_64.tar.gz

Requires:       ffmpeg
Requires:       fontconfig
Requires:       libxkbcommon
Requires:       libX11

%description
Modern video converter designed specifically for DaVinci Resolve on Linux.
Transcodes videos to DaVinci Resolve compatible MOV format with PCM audio,
supports web downloading and multi-track waveform audio synchronization.

%prep
%setup -q -c -T -a 0

%install
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/scalable/apps

install -m 755 rconv-gui %{buildroot}%{_bindir}/rconv-gui
install -m 644 packaging/rconv-gui.desktop %{buildroot}%{_datadir}/applications/rconv-gui.desktop
install -m 644 packaging/rconv-gui.svg %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/rconv-gui.svg

%files
%{_bindir}/rconv-gui
%{_datadir}/applications/rconv-gui.desktop
%{_datadir}/icons/hicolor/scalable/apps/rconv-gui.svg
