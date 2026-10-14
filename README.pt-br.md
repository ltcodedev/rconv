# @ltcode/rconv

[![npm version](https://img.shields.io/npm/v/@ltcode/rconv.svg)](https://www.npmjs.com/package/@ltcode/rconv)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

CLI e biblioteca para converter vídeos para formato compatível com DaVinci Resolve. Funciona com Bun e Node.js.

## Funcionalidades

- Converte vídeos para `.mov` (MPEG-4 + PCM audio) compatível com DaVinci Resolve
- Baixa vídeos da Web via `yt-dlp` (YouTube, Vimeo, etc.) já convertidos para `.mov`
- Suporte a wildcards e padrões glob (`*.mp4`, `*.mkv`)
- Busca recursiva em diretórios com preservação de estrutura
- Seleção de faixas de áudio específicas
- Central de controle interativa (TUI) com navegador de arquivos e download por URL
- Ctrl+C cancela todas as conversões e downloads em andamento de forma limpa
- Funciona como CLI e biblioteca

## Instalação

### Via npm

O pacote é publicado no registro npm. Este é o método recomendado para instalação global. A TUI interativa requer Bun 1.3 ou superior em tempo de execução:

```bash
npm install -g @ltcode/rconv
```

### Via Bun

```bash
bun install -g @ltcode/rconv
```

### Atualizações

O `rconv` consulta o registro npm uma vez por dia e avisa quando existir uma versão nova. Para atualizar:

```bash
npm install -g @ltcode/rconv@latest
```

### Shell Script (Legacy)

Para usuários que preferem o script shell original:

```bash
curl -sL https://raw.githubusercontent.com/eulucastiagolt/resolver-converter-shell/main/install.sh | bash
```

Veja [legacy/README-legacy.pt-br.md](legacy/README-legacy.pt-br.md) para detalhes.

## Uso via CLI

### Sintaxe básica

```bash
rconv -i <entrada> -o <saída>
```

### Opções principais

| Opção | Descrição |
|-------|-----------|
| `-i, --input <padrão ou URL>` | Arquivo de vídeo, padrão (ex: `*.mp4`, `*.mkv`) ou URL de vídeo |
| `-o, --output <dir>` | Diretório de saída para arquivos convertidos |
| `-r, --recursive` | Busca recursiva em subdiretórios (preserva estrutura) |
| `-m, --map-audio <faixas>` | Mapeia faixas de áudio específicas (separadas por vírgula, ex: `1,3,5`) |
| `-q, --quality <qualidade>` | Qualidade do download (`best`, `1080p`, `720p`, `480p`, `360p`, `audio`) [padrão: `best`] |
| `-F, --list-qualities` | Consulta e lista todas as qualidades disponíveis no vídeo e sai |
| `--keep-original` | Mantém o arquivo original baixado ao baixar via URL |
| `-v, --version` | Mostra versão |
| `-h, --help` | Mostra ajuda |

### Download de Vídeos da Web (yt-dlp)

Você pode baixar vídeos da Web usando o subcomando `download` (ou `dl`) e escolher a qualidade:

```bash
# Consultar quais resoluções estão disponíveis para o vídeo antes de baixar:
rconv dl "https://www.youtube.com/watch?v=VIDEO_ID" -F

# Baixa na melhor qualidade e converte para .mov
rconv download "https://www.youtube.com/watch?v=VIDEO_ID" -o ./saida

# Escolhendo resolução específica (ex: 1080p, 720p, 480p)
rconv dl "https://www.youtube.com/watch?v=VIDEO_ID" -q 1080p

# Baixando apenas o áudio convertido em PCM .mov
rconv dl "https://www.youtube.com/watch?v=VIDEO_ID" -q audio

# Mantendo o arquivo original baixado junto com o .mov convertido
rconv dl "https://www.youtube.com/watch?v=VIDEO_ID" -q 720p --keep-original
```

Ou usando diretamente a flag `-i` com uma URL:

```bash
rconv -i "https://www.youtube.com/watch?v=VIDEO_ID" -o ./saida -q 1080p
```

### Central de Controle Interativa com Abas (TUI)

```bash
rconv tui
```

A nova TUI conta com interface organizada em **Abas superiores** e ações em **Botões intuitivos**:

1. **📁 1. Arquivos Locais**:
   - Botões de ação direta (`[ 📥 Entrada ]`, `[ 📤 Saída ]`, `[ 📁 Nova Pasta ]`, `[ 🚀 Iniciar ]`, etc.)
   - Navegador visual de pastas e arquivos de mídia
   - Cartão com resumo da configuração
2. **🌐 2. Baixar da Web (yt-dlp)**:
   - Botão para colar/digitar a URL do vídeo
   - Seletor visual de qualidade: `Melhor (4K)`, `1080p`, `720p`, `480p`, `360p` ou `Apenas Áudio`
   - Opção para manter ou apagar o vídeo original baixado
   - Definição da pasta de destino e botão de início
3. **ℹ️ 3. Sobre & Ajuda**:
   - Status do FFmpeg e yt-dlp, informações dos codecs e guia de atalhos

Atalhos de teclado principais da TUI:
- `1`, `2`, `3` (ou `F1`, `F2`, `F3`): alternar diretamente entre as abas
- `Tab`: alternar o foco entre os painéis da aba ativa
- `↑` / `↓`: navegar opções e botões
- `Enter`: selecionar / executar ação
- `P`: digitar caminho de pasta
- `N`: criar pasta com nome customizado
- `Esc`: fechar menus ou sair
- `Ctrl + C`: cancelar operação com segurança

### 🖥️ Interface Gráfica Nativa Desktop (GUI em Rust & Slint)

Além da CLI e da TUI, o projeto inclui uma versão gráfica desktop elegante escrita em **Rust** utilizando **Slint UI**:
- **100% Nativo para Wayland & X11**: Renderização direta por aceleração de hardware (OpenGL/FemtoVG), sem WebKitGTK ou Chromium, garantindo estabilidade e compatibilidade perfeita no Linux.
- **Distribuído exclusivamente pelo GitHub**: Não é empacotado no npm. Binários prontos e compactados ficam disponíveis na aba [Releases do GitHub](https://github.com/lucastiagoo/resolver-converter/releases).

Para compilar e executar a GUI em desenvolvimento:
```bash
cd gui
cargo run --release
```

### Exemplos de Conversão Local

```bash
# Converter um único arquivo
rconv -i video.mp4 -o ./saida

# Converter múltiplos arquivos com wildcard
rconv -i "*.mp4" -o ./convertidos

# Converter recursivamente em subdiretórios
rconv -r -i "*.mkv" -o ./saida

# Selecionar faixas de áudio específicas
rconv -i video.mp4 -o ./saida -m 1,3

# Usar brace expansion (sem aspas)
rconv -i *.{mp4,mkv,avi} -o ./saida
```

## Uso como Biblioteca

### Instalar como dependência

```bash
npm install @ltcode/rconv
# ou
bun add @ltcode/rconv
```

### API

```typescript
import { 
  convertVideo, 
  convertMultiple, 
  downloadAndConvert, 
  checkFfmpeg, 
  checkYtDlp 
} from '@ltcode/rconv';

// 1. Baixar e converter de URL
const dlResult = await downloadAndConvert({
  url: 'https://www.youtube.com/watch?v=VIDEO_ID',
  output: './saida',
  keepOriginal: false, // opcional (padrão: false)
  onDownloadProgress: (percent, statusText) => {
    console.log(`Download: ${percent}%`);
  },
  onConvertProgress: (percent) => {
    console.log(`Conversão: ${percent}%`);
  },
  onComplete: (result) => {
    console.log(`Concluído: ${result.output}`);
  },
});

// 2. Converter um único vídeo local
const result = await convertVideo({
  input: 'video.mp4',
  output: './saida',
  audioTracks: [1, 3], // opcional
});

// 3. Converter múltiplos vídeos
const results = await convertMultiple({
  input: '*.mp4',
  output: './convertidos',
  recursive: true, // opcional
  onProgress: (percent, file) => {
    console.log(`${file}: ${percent}%`);
  },
});

// 4. Verificar dependências
if (!checkFfmpeg()) {
  console.error('FFmpeg não encontrado');
}
if (!checkYtDlp()) {
  console.error('yt-dlp não encontrado');
}
```

## Interface Gráfica (GUI em Rust)

O `rconv` conta com uma interface gráfica nativa em **Rust** desenvolvida com **Slint**, oferecendo alto desempenho, baixo consumo de memória e suporte direto a Wayland e X11.

> [!NOTE]
> A GUI é distribuída como binário nativo no GitHub Releases e não é publicada no registro npm.

### Funcionalidades da GUI

- **Download inteligente**: Cole URLs do YouTube ou da Web diretamente da área de transferência (`Ctrl+V` ou botão integrado) com detecção automática de resoluções disponíveis (4K, 2K, 1080p, 720p, etc.).
- **Garantia de áudio DaVinci Resolve**: Mesclagem e conversão para `.mov` com áudio **Linear PCM 16-bit** (`pcm_s16le`).
- **Mapeamento de faixas de áudio**: Identifica faixas de áudio existentes no vídeo via `ffprobe` e permite selecionar faixas específicas.
- **Extração Apenas Áudio**: Modo dedicado para extrair a faixa sonora sem vídeo em PCM `.mov`.
- **Múltiplas faixas de áudio externo & Waveform Sync**: Adicione gravações de microfones externos (.wav, .mp3, etc.) com alinhamento automático por correlação de ondas sonoras via FFT, seletor de canal de referência do vídeo e compensação manual de offset.
- **Preservação de hierarquia**: Converte pastas inteiras recursivamente mantendo a mesma estrutura de diretórios no destino.
- **Ações pós-conversão**: Botões rápidos para abrir a pasta de destino ou reproduzir o vídeo gerado no player padrão do sistema.
- **Persistência de configurações**: Mantém pastas de download e destino salvas entre sessões em `~/.config/rconv/settings.json`.

### Execução e Desenvolvimento (Hot Reload)

```bash
# Executar a GUI em modo de desenvolvimento
bun run gui:dev
# ou: cargo run --manifest-path gui/Cargo.toml

# Executar com Hot Reload automático (recompila e reinicia ao alterar o código ou UI)
bun run gui:watch
# ou: cargo watch -C gui -x run

# Compilar versão de lançamento (Release)
bun run gui:build
```

## Requisitos

- **FFmpeg**: obrigatório para conversão de vídeo
- **yt-dlp**: obrigatório caso utilize a funcionalidade de download de vídeos da Web

### Instalação das dependências

```bash
# Ubuntu / Debian
sudo apt install ffmpeg yt-dlp

# Fedora
sudo dnf install ffmpeg yt-dlp

# Arch Linux
sudo pacman -S ffmpeg yt-dlp

# macOS
brew install ffmpeg yt-dlp

# Python (para atualizar yt-dlp caso necessário)
pip install -U yt-dlp
```

## Formatos Suportados

Qualquer formato suportado pelo FFmpeg pode ser usado como entrada. A saída é `.mov` com codec MPEG-4 e áudio PCM, amplamente compatível com DaVinci Resolve no Linux.

## Licença

MIT - Veja [LICENSE](LICENSE) para detalhes.

## Autor

Lucas Tiago - [GitHub](https://github.com/eulucastiagolt) - [Website](https://www.lucastiago.com.br)
