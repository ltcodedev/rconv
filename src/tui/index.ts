import '@opentui/core/runtime-plugin-support';
import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
} from '@opentui/core';
import type { SelectOption } from '@opentui/core';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { checkFfmpeg, convertMultiple, getAudioTracks } from '../converter.js';
import { checkYtDlp, downloadAndConvert, fetchVideoMetadata, isHttpUrl } from '../downloader.js';
import type { AudioTrack, VideoMetadata, VideoQuality } from '../types/index.js';
import { expandGlobPattern } from '../utils/glob-expander.js';
import { cancel, resetCancellation } from '../utils/signal-handler.js';
import {
  createNamedOutputDirectory,
  createOutputDirectory,
  getDirectorySuggestions,
  getBrowserEntries,
  resolveDirectoryPath,
  type BrowserEntry,
} from './browser.js';

const backgroundColor = '#1e1e2e';
const panelColor = '#181825';
const borderColor = '#45475a';
const accentColor = '#89b4fa';
const mutedColor = '#a6adc8';
const successColor = '#a6e3a1';
const warningColor = '#f9e2af';
const videoPattern = '*.{mp4,MP4,avi,AVI,mkv,MKV,webm,WEBM,mov,MOV,flv,FLV,mpeg,MPEG,mpg,MPG,wmv,WMV,m4v,M4V,3gp,3GP,3g2,3G2}';

const QUALITY_OPTIONS: { name: string; description: string; value: VideoQuality }[] = [
  { name: '⭐ Melhor Qualidade (Máxima / 4K)', description: 'Baixa a melhor resolução e taxa de bits disponível', value: 'best' },
  { name: '🎥 1080p (Full HD)', description: 'Resolução recomendada para DaVinci Resolve', value: '1080p' },
  { name: '📺 720p (HD)', description: 'Resolução compacta de alta velocidade', value: '720p' },
  { name: '📱 480p (SD)', description: 'Qualidade padrão reduzida para testes rápidos', value: '480p' },
  { name: '💾 360p (Econômico)', description: 'Tamanho mínimo de arquivo', value: '360p' },
  { name: '🎵 Apenas Áudio (PCM Linear)', description: 'Extrai somente o áudio convertido em PCM .mov', value: 'audio' },
];

export async function runTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('rconv tui requires an interactive terminal.');
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    clearOnShutdown: true,
  });

  const root = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    backgroundColor,
    padding: 1,
    gap: 1,
  });

  // 1. Cabeçalho
  const header = new BoxRenderable(renderer, {
    width: '100%',
    height: 3,
    flexDirection: 'row',
    justifyContent: 'space-between',
    border: true,
    borderColor,
    backgroundColor: panelColor,
    paddingX: 1,
  });
  header.add(new TextRenderable(renderer, {
    content: '🎬 RCONV  •  Conversor para DaVinci Resolve',
    fg: '#d9e8ff',
  }));
  const ffmpegOk = checkFfmpeg();
  const ytdlpOk = checkYtDlp();
  header.add(new TextRenderable(renderer, {
    content: `FFmpeg: ${ffmpegOk ? '✓' : '✗'}  •  yt-dlp: ${ytdlpOk ? '✓' : '✗'}  •  Formato: .mov (MPEG-4/PCM)`,
    fg: ffmpegOk && ytdlpOk ? successColor : warningColor,
  }));

  // 2. Abas de Navegação Superior
  const tabs = new TabSelectRenderable(renderer, {
    width: '100%',
    height: 3,
    tabWidth: 28,
    options: [
      { name: '📁 1. Arquivos Locais', description: 'Converter vídeos e pastas do computador', value: 'files' },
      { name: '🌐 2. Baixar da Web', description: 'Baixar do YouTube/Web via yt-dlp e converter', value: 'download' },
      { name: 'ℹ️ 3. Sobre & Ajuda', description: 'Instruções, codecs e atalhos de teclado', value: 'help' },
    ],
    showUnderline: true,
    showDescription: false,
    backgroundColor: panelColor,
    selectedBackgroundColor: '#313244',
    selectedTextColor: accentColor,
  });

  // 3. Container de Abas (Workspaces)
  const workspacesContainer = new BoxRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    flexDirection: 'column',
  });

  // --- ABA 1: ARQUIVOS LOCAIS ---
  const filesWorkspace = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'row',
    gap: 1,
    visible: true,
  });

  const actionsPanel = new BoxRenderable(renderer, {
    width: '26%',
    height: '100%',
    flexDirection: 'column',
    border: true,
    borderColor,
    backgroundColor: panelColor,
    title: 'Ações',
    padding: 1,
  });

  const actions = new SelectRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    options: [
      { name: '📥 Usar Pasta como Entrada', description: 'Converte vídeos desta pasta e subpastas', value: 'input' },
      { name: '📤 Usar Pasta como Saída', description: 'Salva os vídeos convertidos nesta pasta', value: 'output' },
      { name: '📁 Criar Subpasta Saída', description: 'Cria rconv-output na pasta atual', value: 'create-output' },
      { name: '🔍 Digitar Caminho (P)', description: 'Abre qualquer diretório pelo caminho', value: 'path' },
      { name: '🏷️ Criar Pasta com Nome (N)', description: 'Cria uma pasta de saída com nome customizado', value: 'named-output' },
      { name: '🎵 Selecionar Faixas de Áudio', description: 'Escolhe faixas específicas de áudio', value: 'audio' },
      { name: '🚀 INICIAR CONVERSÃO', description: 'Inicia o processo da fila configurada', value: 'start' },
      { name: '🛑 Cancelar Operação', description: 'Interrompe a conversão em andamento', value: 'cancel' },
      { name: '🏠 Ir para Pasta Pessoal', description: 'Volta ao diretório inicial (~)', value: 'home' },
    ],
    showDescription: true,
    wrapSelection: true,
    selectedBackgroundColor: '#313244',
    selectedTextColor: accentColor,
  });
  actionsPanel.add(actions);

  const browserPanel = new BoxRenderable(renderer, {
    width: '46%',
    height: '100%',
    flexDirection: 'column',
    border: true,
    borderColor,
    backgroundColor: panelColor,
    title: 'Biblioteca de Mídia',
    padding: 1,
    gap: 1,
  });

  const location = new TextRenderable(renderer, { fg: accentColor });
  const browser = new SelectRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    showScrollIndicator: true,
    showDescription: true,
    wrapSelection: true,
    selectedBackgroundColor: '#313244',
    selectedTextColor: accentColor,
  });
  browserPanel.add(location);
  browserPanel.add(browser);

  const detailsPanel = new BoxRenderable(renderer, {
    flexGrow: 1,
    height: '100%',
    flexDirection: 'column',
    border: true,
    borderColor,
    backgroundColor: panelColor,
    title: 'Configuração Atual',
    padding: 1,
    gap: 1,
  });
  const configuration = new TextRenderable(renderer, { fg: '#cdd6f4', wrapMode: 'word' });
  detailsPanel.add(configuration);

  filesWorkspace.add(actionsPanel);
  filesWorkspace.add(browserPanel);
  filesWorkspace.add(detailsPanel);

  // --- ABA 2: BAIXAR DA WEB (yt-dlp) ---
  const downloadWorkspace = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'row',
    gap: 1,
    visible: false,
  });

  const dlActionsPanel = new BoxRenderable(renderer, {
    width: '38%',
    height: '100%',
    flexDirection: 'column',
    border: true,
    borderColor,
    backgroundColor: panelColor,
    title: 'Ações de Download',
    padding: 1,
    gap: 1,
  });

  const dlActions = new SelectRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    options: [
      { name: '🔗 Digitar / Colar URL', description: 'Inserir link do YouTube, Vimeo, etc.', value: 'url' },
      { name: '🎥 Escolher Resolução (Tab/→)', description: 'Navegar diretamente para a lista de qualidades', value: 'quality' },
      { name: '📦 Manter Original: NÃO', description: 'Alterna entre manter ou apagar o vídeo baixado', value: 'toggle-keep' },
      { name: '📂 Pasta de Destino', description: 'Altera o diretório onde o .mov será salvo', value: 'dest' },
      { name: '⬇️ INICIAR DOWNLOAD', description: 'Baixa via yt-dlp e converte para DaVinci Resolve', value: 'start-dl' },
      { name: '🛑 Cancelar Download', description: 'Interrompe o download/conversão atual', value: 'cancel-dl' },
    ],
    showDescription: true,
    wrapSelection: true,
    selectedBackgroundColor: '#313244',
    selectedTextColor: accentColor,
  });
  dlActionsPanel.add(dlActions);

  const dlRightPanel = new BoxRenderable(renderer, {
    flexGrow: 1,
    height: '100%',
    flexDirection: 'column',
    gap: 1,
  });

  const dlInfoPanel = new BoxRenderable(renderer, {
    width: '100%',
    height: 6,
    flexDirection: 'column',
    border: true,
    borderColor,
    backgroundColor: panelColor,
    title: 'Informações do Vídeo',
    padding: 1,
  });
  const dlInfoText = new TextRenderable(renderer, { fg: '#cdd6f4', wrapMode: 'word' });
  dlInfoPanel.add(dlInfoText);

  const dlQualityPanel = new BoxRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    flexDirection: 'column',
    border: true,
    borderColor,
    backgroundColor: panelColor,
    title: 'Qualidades Disponíveis (Tab/Setas para navegar)',
    padding: 1,
  });
  const dlQualitySelector = new SelectRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    options: QUALITY_OPTIONS,
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: true,
    selectedBackgroundColor: '#313244',
    selectedTextColor: accentColor,
  });
  dlQualityPanel.add(dlQualitySelector);

  dlRightPanel.add(dlInfoPanel);
  dlRightPanel.add(dlQualityPanel);

  downloadWorkspace.add(dlActionsPanel);
  downloadWorkspace.add(dlRightPanel);

  // --- ABA 3: SOBRE & AJUDA ---
  const helpWorkspace = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    border: true,
    borderColor,
    backgroundColor: panelColor,
    title: 'Sobre o rconv & Guia de Uso',
    padding: 1,
    gap: 1,
    visible: false,
  });
  const helpText = new TextRenderable(renderer, { fg: '#cdd6f4', wrapMode: 'word' });
  helpText.content = [
    '📌 O que é o rconv?',
    'Uma ferramenta projetada para converter qualquer vídeo da Web ou do computador',
    'em um formato nativamente compatível com o DaVinci Resolve no Linux (container .mov com vídeo MPEG-4 e áudio PCM 16-bit).',
    '',
    '⌨️ Atalhos de Teclado Globais:',
    '  • 1, 2, 3       : Alternar diretamente entre as abas',
    '  • Tab / ← / →   : Alternar foco entre colunas e painéis visíveis',
    '  • ↑ / ↓         : Navegar pelas opções, qualidades e arquivos',
    '  • Enter         : Executar ação ou selecionar item',
    '  • P             : Digitar caminho de pasta (na aba de arquivos)',
    '  • N             : Criar nova pasta com nome (na aba de arquivos)',
    '  • Esc           : Fechar popups/cancelar digitação ou sair da aplicação',
    '  • Ctrl + C      : Cancelar processo em andamento com segurança',
    '',
    '⚙️ Dependências do Sistema:',
    `  • FFmpeg : ${ffmpegOk ? '✓ Detectado no PATH' : '✗ NÃO ENCONTRADO (Instale com: sudo apt install ffmpeg)'}`,
    `  • yt-dlp : ${ytdlpOk ? '✓ Detectado no PATH' : '✗ NÃO ENCONTRADO (Instale com: sudo apt install yt-dlp)'}`,
  ].join('\n');
  helpWorkspace.add(helpText);

  workspacesContainer.add(filesWorkspace);
  workspacesContainer.add(downloadWorkspace);
  workspacesContainer.add(helpWorkspace);

  // 4. Painel Inferior (Fila de Conversão, Progresso e Logs)
  const queuePanel = new BoxRenderable(renderer, {
    width: '100%',
    height: 7,
    flexDirection: 'column',
    border: true,
    borderColor,
    backgroundColor: panelColor,
    title: 'Progresso & Eventos',
    paddingX: 1,
  });
  const queuePreview = new TextRenderable(renderer, { fg: mutedColor, wrapMode: 'none' });
  const progress = new TextRenderable(renderer, { fg: accentColor, wrapMode: 'none' });
  const logs = new TextRenderable(renderer, { fg: mutedColor, wrapMode: 'none' });
  queuePanel.add(queuePreview);
  queuePanel.add(progress);
  queuePanel.add(logs);

  // 5. Painel Flutuante de Prompt (Entrada manual de texto)
  const promptPanel = new BoxRenderable(renderer, {
    width: '100%',
    height: 6,
    flexDirection: 'column',
    border: true,
    borderColor: accentColor,
    backgroundColor: panelColor,
    padding: 1,
    visible: false,
  });
  const promptLabel = new TextRenderable(renderer, { height: 1, fg: accentColor });
  const manualInput = new InputRenderable(renderer, { width: '100%' });
  const suggestions = new SelectRenderable(renderer, {
    width: '100%',
    height: 4,
    showDescription: false,
    showScrollIndicator: true,
    wrapSelection: false,
    selectedBackgroundColor: '#313244',
    selectedTextColor: accentColor,
    visible: false,
  });
  promptPanel.add(promptLabel);
  promptPanel.add(manualInput);
  promptPanel.add(suggestions);

  // 6. Painel Flutuante de Seleção de Faixas de Áudio
  const audioPanel = new BoxRenderable(renderer, {
    width: '100%',
    height: 8,
    flexDirection: 'column',
    border: true,
    borderColor: accentColor,
    backgroundColor: panelColor,
    padding: 1,
    visible: false,
  });
  const audioLabel = new TextRenderable(renderer, { height: 1, fg: accentColor });
  const audioSelector = new SelectRenderable(renderer, {
    width: '100%',
    flexGrow: 1,
    showDescription: true,
    showScrollIndicator: true,
    selectedBackgroundColor: '#313244',
    selectedTextColor: accentColor,
  });
  audioPanel.add(audioLabel);
  audioPanel.add(audioSelector);

  // 7. Barra de Status e Rodapé
  const status = new TextRenderable(renderer, { fg: '#f5e0dc' });
  const footer = new TextRenderable(renderer, {
    content: '1/2/3: Alternar Abas  •  Tab/←/→: Mudar Painel  •  ↑/↓: Navegar  •  Enter: Selecionar  •  Esc: Voltar/Sair  •  Ctrl+C: Cancelar',
    fg: mutedColor,
  });

  root.add(header);
  root.add(tabs);
  root.add(workspacesContainer);
  root.add(queuePanel);
  root.add(promptPanel);
  root.add(audioPanel);
  root.add(status);
  root.add(footer);

  renderer.root.add(root);

  // --- ESTADO DA APLICAÇÃO ---
  let currentTab: 'files' | 'download' | 'help' = 'files';
  let browserDirectory = process.cwd();
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let recursive = false;
  let audioTracks: number[] | undefined;
  let availableAudioTracks: AudioTrack[] = [];

  // Estado da aba de Download
  let downloadUrl = '';
  let selectedQuality: VideoQuality = 'best';
  let keepOriginalVideo = false;
  let downloadOutputDir = process.cwd();
  let videoMetadata: VideoMetadata | undefined;

  let running = false;
  let totalFiles = 0;
  let completedFiles = 0;
  let currentProgress = 0;
  const logEntries: string[] = [];
  let promptMode: 'path' | 'named-output' | 'download-url' | 'download-output' | undefined;

  // Atualização das configurações visuais
  const refreshConfiguration = () => {
    configuration.content = [
      `📂 Entrada:\n${inputPath || 'Nenhuma (selecione um vídeo ou pasta)'}`,
      '',
      `📁 Saída:\n${outputPath || 'Nenhuma (defina uma pasta de saída)'}`,
      '',
      `⚙️ Modo: ${recursive ? 'Pasta completa e subpastas' : 'Arquivo único'}`,
      `🎵 Áudio: ${audioTracks?.length ? `Faixas [${audioTracks.join(', ')}]` : 'Todas as faixas (Padrão)'}`,
    ].join('\n');

    updateQueuePreview();
  };

  const updateQueuePreview = () => {
    if (currentTab === 'download') {
      if (running) {
        queuePreview.content = `🌐 Baixando: ${downloadUrl ? (downloadUrl.length > 35 ? downloadUrl.slice(0, 32) + '...' : downloadUrl) : 'vídeo'} [${getQualityLabel(selectedQuality)}]`;
      } else if (downloadUrl) {
        queuePreview.content = `🌐 URL pronta: ${downloadUrl.length > 35 ? downloadUrl.slice(0, 32) + '...' : downloadUrl}  ➔  ${basename(downloadOutputDir)}`;
      } else {
        queuePreview.content = '🌐 Nenhum download ativo (insira uma URL na aba 2 para baixar).';
      }
    } else {
      if (running) {
        queuePreview.content = '📁 Processando fila de conversão local...';
      } else if (inputPath && outputPath) {
        queuePreview.content = `📁 Fila configurada: ${basename(inputPath)}  ➔  ${basename(outputPath)}`;
      } else {
        queuePreview.content = '📁 Nenhum trabalho local configurado (selecione entrada e saída na aba 1).';
      }
    }
  };

  const getQualityLabel = (quality: VideoQuality): string => {
    const list = videoMetadata?.qualities?.length ? videoMetadata.qualities : QUALITY_OPTIONS;
    const found = list.find((opt) => opt.value === quality);
    return found ? found.name.replace(/^[●○✓⭐🎥📺📱💾🎵]\s*/, '').trim() : quality;
  };

  const refreshDownloadDetails = () => {
    dlActions.options = [
      {
        name: downloadUrl ? `🔗 URL: ${downloadUrl.length > 25 ? downloadUrl.slice(0, 22) + '...' : downloadUrl}` : '🔗 Digitar / Colar URL',
        description: 'Inserir link do YouTube, Vimeo, etc.',
        value: 'url',
      },
      {
        name: `🎥 Qualidade: ${getQualityLabel(selectedQuality)}`,
        description: 'Pressione Enter ou Tab/→ para escolher na lista ao lado',
        value: 'quality',
      },
      {
        name: `📦 Manter Original: ${keepOriginalVideo ? 'SIM' : 'NÃO'}`,
        description: 'Alterna manter o arquivo original baixado além do .mov',
        value: 'toggle-keep',
      },
      {
        name: `📂 Destino: ${basename(downloadOutputDir) || downloadOutputDir}`,
        description: `Salvar em: ${downloadOutputDir}`,
        value: 'dest',
      },
      {
        name: '⬇️ INICIAR DOWNLOAD',
        description: 'Baixa via yt-dlp e converte automaticamente para DaVinci Resolve',
        value: 'start-dl',
      },
      {
        name: '🛑 Cancelar Download',
        description: 'Interrompe o processo ativo',
        value: 'cancel-dl',
      },
    ];

    const currentList = videoMetadata?.qualities?.length ? videoMetadata.qualities : QUALITY_OPTIONS;
    dlQualitySelector.options = currentList.map((opt) => {
      const cleanName = opt.name.replace(/^[●○✓]\s*/, '');
      return {
        name: `${opt.value === selectedQuality ? '● ' : '○ '}${cleanName}`,
        description: opt.description,
        value: opt.value,
      };
    });

    const lines = [
      videoMetadata?.title ? `🎬 ${videoMetadata.title}` : `🔗 URL: ${downloadUrl || '(Nenhuma URL informada - clique em Digitar URL)'}`,
      videoMetadata?.duration
        ? `⏱️ Duração: ${Math.floor(videoMetadata.duration / 60)}:${(videoMetadata.duration % 60).toString().padStart(2, '0')}  •  Resolução Selecionada: ${getQualityLabel(selectedQuality)}`
        : `Resolução ativa: ${getQualityLabel(selectedQuality)}  •  Preservar original: ${keepOriginalVideo ? 'Sim' : 'Não'}`,
      videoMetadata
        ? `✓ ${videoMetadata.qualities.length} resoluções reais detectadas pelo yt-dlp para este vídeo.`
        : '💡 Dica: Cole uma URL para verificar automaticamente as resoluções disponíveis.',
    ];
    dlInfoText.content = lines.join('\n');
    updateQueuePreview();
  };

  // Atualização segura do progresso (sem RangeError)
  const updateProgress = () => {
    const rawPercent = totalFiles === 0
      ? 0
      : Math.round(((completedFiles + currentProgress / 100) / totalFiles) * 100);

    const percent = Math.min(100, Math.max(0, isNaN(rawPercent) ? 0 : rawPercent));
    const filled = Math.min(20, Math.max(0, Math.round(percent / 5)));
    const empty = Math.max(0, 20 - filled);

    progress.content = `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%  (${completedFiles}/${totalFiles} concluídos)`;
  };

  const addLog = (message: string) => {
    const time = new Date().toLocaleTimeString('pt-BR');
    logEntries.unshift(`[${time}] ${message}`);
    logs.content = logEntries.slice(0, 2).join('\n');
  };

  const switchTab = (tab: 'files' | 'download' | 'help') => {
    currentTab = tab;
    filesWorkspace.visible = tab === 'files';
    downloadWorkspace.visible = tab === 'download';
    helpWorkspace.visible = tab === 'help';

    tabs.setSelectedIndex(tab === 'files' ? 0 : tab === 'download' ? 1 : 2);
    updateQueuePreview();

    if (tab === 'files') {
      actions.focus();
    } else if (tab === 'download') {
      dlActions.focus();
    } else {
      tabs.focus();
    }
  };

  const refreshBrowser = () => {
    const entries = getBrowserEntries(browserDirectory);
    const options: SelectOption[] = entries.map((entry) => ({
      name: entry.kind === 'video' ? `🎬 ${entry.name}` : `📁 ${entry.name}`,
      description: entry.kind === 'video' ? 'Selecionar este vídeo' : 'Entrar nesta pasta',
      value: entry,
    }));

    browser.options = options;
    browser.setSelectedIndex(0);
    location.content = `Pasta atual: ${browserDirectory}`;
  };

  const closePrompt = () => {
    promptMode = undefined;
    promptPanel.visible = false;
    suggestions.visible = false;
    manualInput.value = '';
    if (currentTab === 'files') {
      actions.focus();
    } else if (currentTab === 'download') {
      dlActions.focus();
    } else {
      tabs.focus();
    }
  };

  const refreshSuggestions = (value: string) => {
    const basePath = promptMode === 'download-output' ? downloadOutputDir : browserDirectory;
    const options = getDirectorySuggestions(value, basePath).map((path) => ({
      name: path,
      description: '',
      value: path,
    }));

    suggestions.options = options;
    const hasOptions = options.length > 0;
    suggestions.visible = hasOptions;
    promptPanel.height = hasOptions ? 9 : 5;
    if (hasOptions) {
      suggestions.setSelectedIndex(0);
    }
  };

  const applySuggestion = () => {
    const suggestion = suggestions.getSelectedOption();
    if (suggestion) {
      manualInput.value = suggestion.value as string;
      refreshSuggestions(manualInput.value);
      manualInput.focus();
    }
  };

  const openPrompt = (mode: 'path' | 'named-output' | 'download-url' | 'download-output') => {
    promptMode = mode;
    if (mode === 'path') {
      promptLabel.content = 'Digite um caminho (Tab autocompleta, ↓ vai para sugestões, Esc cancela):';
      manualInput.placeholder = '/caminho/para/pasta';
    } else if (mode === 'named-output') {
      promptLabel.content = 'Digite o nome da nova pasta de saída (Enter confirma, Esc cancela):';
      manualInput.placeholder = 'ex: videos-convertidos';
    } else if (mode === 'download-url') {
      promptLabel.content = 'Cole ou digite a URL do vídeo (Enter confirma, Esc cancela):';
      manualInput.placeholder = 'https://www.youtube.com/watch?v=...';
    } else if (mode === 'download-output') {
      promptLabel.content = 'Digite a pasta para salvar o vídeo (Tab autocompleta, ↓ sugestões, Esc cancela):';
      manualInput.placeholder = downloadOutputDir;
    }

    manualInput.value = '';
    promptPanel.visible = true;
    if (mode === 'path' || mode === 'download-output') {
      refreshSuggestions('');
      suggestions.visible = suggestions.options.length > 0;
      promptPanel.height = suggestions.visible ? 9 : 5;
    } else {
      suggestions.visible = false;
      promptPanel.height = 5;
    }
    manualInput.focus();
  };

  const refreshAudioOptions = () => {
    audioSelector.options = availableAudioTracks.map((track) => ({
      name: `${audioTracks?.includes(track.index) ? '◉' : '○'} Faixa ${track.index}`,
      description: [track.codec, track.channels ? `${track.channels} canais` : '', track.language ?? '']
        .filter(Boolean)
        .join(' • '),
      value: track.index,
    }));
  };

  const closeAudioPanel = () => {
    audioPanel.visible = false;
    actions.focus();
  };

  const openAudioPanel = async () => {
    if (!inputPath) {
      status.content = 'Selecione uma entrada antes de configurar o áudio.';
      return;
    }

    audioPanel.visible = true;
    audioLabel.content = 'Buscando faixas de áudio com ffprobe...';
    audioSelector.options = [];

    try {
      const [file] = await expandGlobPattern(inputPath, recursive);
      if (!file) {
        status.content = 'Nenhum vídeo encontrado para analisar faixas de áudio.';
        closeAudioPanel();
        return;
      }

      availableAudioTracks = await getAudioTracks(file);
      if (availableAudioTracks.length === 0) {
        status.content = 'O vídeo selecionado não contém faixas de áudio.';
        closeAudioPanel();
        return;
      }

      audioLabel.content = 'Enter alterna faixa  •  A seleciona todas  •  Esc confirma';
      refreshAudioOptions();
      audioSelector.focus();
    } catch (error) {
      status.content = error instanceof Error ? error.message : 'Não foi possível analisar o áudio.';
      closeAudioPanel();
    }
  };

  // Execuções
  const startConversion = async () => {
    if (running) {
      status.content = 'Já existe uma conversão em andamento.';
      return;
    }

    if (!inputPath || !outputPath) {
      status.content = 'Escolha uma entrada e uma saída antes de iniciar.';
      return;
    }

    running = true;
    totalFiles = 0;
    completedFiles = 0;
    currentProgress = 0;
    logEntries.length = 0;
    resetCancellation();
    addLog('Iniciando fila de conversão...');
    updateProgress();
    updateQueuePreview();

    try {
      const results = await convertMultiple({
        input: inputPath,
        output: outputPath,
        recursive,
        audioTracks,
        manageSignals: false,
        onQueue: (files) => {
          totalFiles = files.length;
          updateProgress();
          addLog(`${files.length} vídeo(s) na fila.`);
        },
        onStart: (file) => {
          currentProgress = 0;
          status.content = `Convertendo: ${basename(file)}`;
        },
        onProgress: (percent) => {
          currentProgress = percent;
          updateProgress();
        },
        onComplete: (file) => {
          completedFiles += 1;
          currentProgress = 0;
          updateProgress();
          addLog(`✓ Concluído: ${basename(file)}`);
        },
        onError: (file, error) => {
          completedFiles += 1;
          currentProgress = 0;
          updateProgress();
          addLog(`✗ Erro em ${basename(file)}: ${error.message.split('\n')[0]}`);
        },
      });

      const failed = results.filter((result) => !result.success).length;
      const summary = failed === 0
        ? `Sucesso: ${results.length} vídeo(s) convertidos para DaVinci Resolve!`
        : `Finalizado com ${failed} erro(s).`;
      status.content = summary;
      addLog(summary);
      refreshBrowser();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha na conversão.';
      status.content = message;
      addLog(`Erro: ${message}`);
    } finally {
      running = false;
      updateQueuePreview();
    }
  };

  const startUrlDownload = async (url: string) => {
    if (running) {
      status.content = 'Já existe uma operação em andamento.';
      return;
    }

    if (!checkYtDlp()) {
      status.content = 'yt-dlp não está instalado. Instale com: sudo apt install yt-dlp';
      addLog('Erro: yt-dlp não encontrado no sistema.');
      return;
    }

    running = true;
    totalFiles = 1;
    completedFiles = 0;
    currentProgress = 0;
    logEntries.length = 0;
    resetCancellation();
    const destination = downloadOutputDir || browserDirectory;

    status.content = `Baixando com yt-dlp (${selectedQuality}): ${url}`;
    addLog(`Iniciando download [${selectedQuality}]: ${url}`);
    updateProgress();
    updateQueuePreview();

    try {
      const result = await downloadAndConvert({
        url,
        output: destination,
        quality: selectedQuality,
        keepOriginal: keepOriginalVideo,
        audioTracks,
        manageSignals: false,
        onDownloadStart: () => {
          status.content = 'Baixando vídeo com yt-dlp...';
        },
        onDownloadProgress: (percent, statusText) => {
          currentProgress = Math.min(50, Math.max(0, percent / 2));
          updateProgress();
          if (statusText) {
            status.content = statusText;
          }
        },
        onDownloadComplete: (file) => {
          currentProgress = 50;
          updateProgress();
          addLog(`Download finalizado: ${basename(file)}`);
        },
        onConvertStart: (file) => {
          status.content = 'Convertendo para formato DaVinci Resolve (.mov)...';
          addLog(`Convertendo para DaVinci: ${basename(file)}`);
        },
        onConvertProgress: (percent) => {
          currentProgress = Math.min(100, 50 + Math.max(0, percent / 2));
          updateProgress();
        },
        onConvertComplete: () => {
          completedFiles = 1;
          currentProgress = 0;
          updateProgress();
        },
        onError: (error) => {
          addLog(`Erro: ${error.message.split('\n')[0]}`);
        },
      });

      if (result.success) {
        status.content = `✓ Vídeo pronto para o DaVinci Resolve! Salvo em: ${result.output}`;
        addLog(`Gerado: ${basename(result.output)}`);
        refreshBrowser();
      } else {
        const errorMsg = result.error?.message || 'Falha no download/conversão';
        status.content = `Erro: ${errorMsg.split('\n')[0]}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível baixar/converter o vídeo.';
      status.content = message;
      addLog(`Erro: ${message}`);
    } finally {
      running = false;
      updateQueuePreview();
    }
  };

  const cancelOperation = () => {
    if (!running) {
      status.content = 'Nenhuma operação está em andamento.';
      return;
    }

    cancel();
    status.content = 'Cancelando processo...';
    addLog('Cancelamento solicitado pelo usuário.');
    updateQueuePreview();
  };

  // --- EVENTOS DE INTERAÇÃO ---

  // Evento das Abas
  tabs.on(TabSelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    switchTab(option.value as 'files' | 'download' | 'help');
  });

  // Eventos do Navegador de Mídia (Aba 1)
  browser.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    const entry = option.value as BrowserEntry;
    if (entry.kind === 'video') {
      inputPath = entry.path;
      recursive = false;
      status.content = `Vídeo selecionado: ${entry.name}`;
      refreshConfiguration();
      return;
    }

    browserDirectory = entry.path;
    refreshBrowser();
  });

  // Eventos de Ações Locais (Aba 1)
  actions.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    switch (option.value) {
      case 'input':
        inputPath = join(browserDirectory, videoPattern);
        recursive = true;
        status.content = 'Pasta atual e subpastas definidas como entrada.';
        break;
      case 'output':
        outputPath = browserDirectory;
        downloadOutputDir = browserDirectory;
        status.content = 'Pasta atual definida como saída.';
        refreshDownloadDetails();
        break;
      case 'create-output':
        outputPath = createOutputDirectory(browserDirectory);
        downloadOutputDir = outputPath;
        status.content = `Pasta de saída criada: ${outputPath}`;
        refreshBrowser();
        refreshDownloadDetails();
        break;
      case 'path':
        openPrompt('path');
        return;
      case 'named-output':
        openPrompt('named-output');
        return;
      case 'audio':
        void openAudioPanel();
        return;
      case 'start':
        void startConversion();
        return;
      case 'cancel':
        cancelOperation();
        return;
      case 'home':
        browserDirectory = homedir();
        refreshBrowser();
        status.content = 'Diretório pessoal aberto.';
        break;
    }
    refreshConfiguration();
  });

  // Eventos de Ações de Download (Aba 2)
  dlActions.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    switch (option.value) {
      case 'url':
        openPrompt('download-url');
        return;
      case 'quality':
        dlQualitySelector.focus();
        status.content = 'Navegue pelas resoluções com ↑/↓ e pressione Enter para selecionar (ou Tab/← para voltar).';
        return;
      case 'toggle-keep':
        keepOriginalVideo = !keepOriginalVideo;
        refreshDownloadDetails();
        status.content = `Manter original baixado: ${keepOriginalVideo ? 'SIM' : 'NÃO'}`;
        return;
      case 'dest':
        openPrompt('download-output');
        return;
      case 'start-dl':
        if (!downloadUrl) {
          status.content = 'Por favor, digite ou cole uma URL primeiro.';
          openPrompt('download-url');
          return;
        }
        void startUrlDownload(downloadUrl);
        return;
      case 'cancel-dl':
        cancelOperation();
        return;
    }
  });

  // Seleção de Qualidade (Diretamente na Aba 2)
  dlQualitySelector.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    selectedQuality = option.value as VideoQuality;
    refreshDownloadDetails();
    status.content = `Qualidade definida: ${getQualityLabel(selectedQuality)}`;
    dlActions.focus();
  });

  // Seleção de Faixas de Áudio
  audioSelector.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
    const trackIndex = option.value as number;
    const selectedTracks = audioTracks?.includes(trackIndex)
      ? audioTracks.filter((idx) => idx !== trackIndex)
      : [...(audioTracks ?? []), trackIndex];

    audioTracks = selectedTracks.length > 0 ? selectedTracks : undefined;
    refreshAudioOptions();
    refreshConfiguration();
  });

  // Submissão de Input Manual (Prompts)
  manualInput.on(InputRenderableEvents.ENTER, (value: string) => {
    const val = value.trim();

    if (promptMode === 'path') {
      const dir = resolveDirectoryPath(val, browserDirectory);
      if (!dir) {
        status.content = 'Não foi possível encontrar essa pasta.';
        return;
      }
      browserDirectory = dir;
      refreshBrowser();
      status.content = 'Pasta aberta com sucesso.';
      closePrompt();
      return;
    }

    if (promptMode === 'named-output') {
      try {
        outputPath = createNamedOutputDirectory(browserDirectory, val);
        downloadOutputDir = outputPath;
        status.content = `Pasta de saída criada: ${outputPath}`;
        refreshBrowser();
        refreshConfiguration();
        refreshDownloadDetails();
        closePrompt();
      } catch (err) {
        status.content = err instanceof Error ? err.message : 'Falha ao criar pasta.';
      }
      return;
    }

    if (promptMode === 'download-url') {
      if (!isHttpUrl(val)) {
        status.content = 'URL inválida. Deve iniciar com http:// ou https://';
        return;
      }
      downloadUrl = val;
      videoMetadata = undefined;
      refreshDownloadDetails();
      closePrompt();
      status.content = 'Verificando qualidades disponíveis com yt-dlp...';
      dlInfoText.content = `🔗 URL: ${downloadUrl}\n⏳ Consultando qualidades disponíveis via yt-dlp...`;
      addLog(`Consultando qualidades disponíveis com yt-dlp...`);

      void (async () => {
        try {
          const meta = await fetchVideoMetadata(downloadUrl);
          videoMetadata = meta;
          if (selectedQuality !== 'best' && !meta.qualities.some((q) => q.value === selectedQuality)) {
            selectedQuality = 'best';
          }
          refreshDownloadDetails();
          const targetIndex = meta.qualities.findIndex((q) => q.value === selectedQuality);
          dlQualitySelector.setSelectedIndex(targetIndex >= 0 ? targetIndex : 0);
          status.content = `Vídeo: ${meta.title} (${meta.qualities.length} resoluções disponíveis)`;
          addLog(`✓ Qualidades carregadas: ${meta.title} (${meta.qualities.length} resoluções)`);
        } catch (err) {
          addLog(`Aviso ao carregar qualidades: ${err instanceof Error ? err.message : String(err)}`);
          refreshDownloadDetails();
        }
      })();
      return;
    }

    if (promptMode === 'download-output') {
      const dir = resolveDirectoryPath(val, downloadOutputDir);
      if (!dir) {
        status.content = 'Não foi possível encontrar essa pasta.';
        return;
      }
      downloadOutputDir = dir;
      refreshDownloadDetails();
      status.content = `Pasta de download definida: ${downloadOutputDir}`;
      closePrompt();
      return;
    }
  });

  manualInput.on(InputRenderableEvents.INPUT, (value: string) => {
    if (promptMode === 'path' || promptMode === 'download-output') {
      refreshSuggestions(value);
    }
  });

  suggestions.on(SelectRenderableEvents.ITEM_SELECTED, () => {
    applySuggestion();
  });

  // --- TRATAMENTO DE TECLADO GLOBAL ---
  renderer.keyInput.on('keypress', (key) => {
    // 1. Modal de Áudio
    if (audioPanel.visible) {
      if (key.name === 'a') {
        key.preventDefault();
        audioTracks = undefined;
        refreshAudioOptions();
        refreshConfiguration();
        return;
      }
      if (key.name === 'escape') {
        key.preventDefault();
        closeAudioPanel();
        return;
      }
    }

    // 2. Painel de Prompt (Digitação & Sugestões)
    if (promptPanel.visible) {
      if (key.name === 'escape') {
        key.preventDefault();
        closePrompt();
        return;
      }

      // Navegação dentro do Prompt (Input <-> Sugestões)
      if (manualInput.focused) {
        if (key.name === 'down' && suggestions.visible && suggestions.options.length > 0) {
          key.preventDefault();
          suggestions.focus();
          suggestions.setSelectedIndex(0);
          return;
        }
        if (key.name === 'tab' && suggestions.visible && suggestions.options.length > 0) {
          key.preventDefault();
          applySuggestion();
          return;
        }
      } else if (suggestions.focused) {
        if (key.name === 'up' && suggestions.getSelectedIndex() <= 0) {
          key.preventDefault();
          manualInput.focus();
          return;
        }
        if (key.name === 'tab') {
          key.preventDefault();
          manualInput.focus();
          return;
        }
        if (key.name === 'backspace') {
          key.preventDefault();
          manualInput.focus();
          manualInput.value = manualInput.value.slice(0, -1);
          if (promptMode === 'path' || promptMode === 'download-output') {
            refreshSuggestions(manualInput.value);
          }
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          key.preventDefault();
          manualInput.focus();
          manualInput.value += key.sequence;
          if (promptMode === 'path' || promptMode === 'download-output') {
            refreshSuggestions(manualInput.value);
          }
          return;
        }
      }
      return; // Durante a digitação no prompt, não processar atalhos globais
    }

    // 3. Teclas rápidas para alternar Abas (1, 2, 3 ou F1, F2, F3)
    if (key.name === '1' || key.name === 'f1') {
      key.preventDefault();
      switchTab('files');
      return;
    }
    if (key.name === '2' || key.name === 'f2') {
      key.preventDefault();
      switchTab('download');
      return;
    }
    if (key.name === '3' || key.name === 'f3') {
      key.preventDefault();
      switchTab('help');
      return;
    }

    // 4. Navegação entre painéis com Tab, Left, Right
    if (currentTab === 'files') {
      if (key.name === 'tab') {
        key.preventDefault();
        if (actions.focused) {
          browser.focus();
        } else {
          actions.focus();
        }
        return;
      }
      if (key.name === 'right' && actions.focused) {
        key.preventDefault();
        browser.focus();
        return;
      }
      if (key.name === 'left' && browser.focused) {
        key.preventDefault();
        actions.focus();
        return;
      }

      // Atalhos rápidos na aba de arquivos
      if (key.name === 'p') {
        key.preventDefault();
        openPrompt('path');
        return;
      }
      if (key.name === 'n') {
        key.preventDefault();
        openPrompt('named-output');
        return;
      }
    } else if (currentTab === 'download') {
      if (key.name === 'tab') {
        key.preventDefault();
        if (dlActions.focused) {
          dlQualitySelector.focus();
          status.content = 'Navegue nas resoluções com ↑/↓ e pressione Enter para confirmar (ou Tab/← para voltar).';
        } else {
          dlActions.focus();
        }
        return;
      }
      if (key.name === 'right' && dlActions.focused) {
        key.preventDefault();
        dlQualitySelector.focus();
        status.content = 'Navegue nas resoluções com ↑/↓ e pressione Enter para confirmar (ou Tab/← para voltar).';
        return;
      }
      if (key.name === 'left' && dlQualitySelector.focused) {
        key.preventDefault();
        dlActions.focus();
        return;
      }
    }

    // 5. Cancelamento ou fechamento
    if (key.ctrl && key.name === 'c' && running) {
      key.preventDefault();
      cancelOperation();
      return;
    }

    if (key.name === 'escape' || (key.ctrl && key.name === 'c') || key.name === 'q') {
      key.preventDefault();
      renderer.destroy();
    }
  });

  // Inicialização
  refreshBrowser();
  refreshConfiguration();
  refreshDownloadDetails();
  updateProgress();
  actions.focus();

  await new Promise<void>((resolve) => {
    renderer.once('destroy', resolve);
  });
}
