mod converter;
mod downloader;
mod settings;
mod aligner;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use slint::{ComponentHandle, ModelRc, VecModel};
use settings::AppSettings;

slint::include_modules!();

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let main_window = MainWindow::new()?;

    // Carregar configurações persistidas do usuário
    let settings = Arc::new(Mutex::new(AppSettings::load()));
    let cancel_flag = Arc::new(AtomicBool::new(false));

    // Estado das qualidades do vídeo e faixas de áudio
    let current_qualities: Arc<Mutex<Vec<downloader::VideoQualityOption>>> = Arc::new(Mutex::new(Vec::new()));
    let available_audio_tracks: Arc<Mutex<Vec<AudioTrackEntry>>> = Arc::new(Mutex::new(Vec::new()));
    let last_file_path: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let external_tracks_state: Arc<Mutex<Vec<ExternalTrackEntry>>> = Arc::new(Mutex::new(Vec::new()));
    let next_track_id = Arc::new(std::sync::atomic::AtomicI32::new(1));

    // Verificação de ferramentas
    let ffmpeg_ok = converter::check_ffmpeg();
    let ytdlp_ok = downloader::check_ytdlp();
    main_window.set_ffmpeg_available(ffmpeg_ok);
    main_window.set_ytdlp_available(ytdlp_ok);

    // Aplicar configurações iniciais salvas
    {
        let s = settings.lock().unwrap();
        main_window.set_download_output(s.download_dir.clone().into());
        main_window.set_output_path(s.output_dir.clone().into());
        main_window.set_keep_original(s.keep_original);
    }

    // 1. Colar da Área de Transferência
    let handle = main_window.as_weak();
    main_window.on_paste_from_clipboard(move || {
        let ui = match handle.upgrade() {
            Some(u) => u,
            None => return,
        };

        match arboard::Clipboard::new().and_then(|mut cb| cb.get_text()) {
            Ok(text) => {
                let trimmed = text.trim();
                if downloader::is_http_url(trimmed) {
                    ui.set_download_url(trimmed.into());
                    ui.invoke_fetch_metadata(trimmed.into());
                } else {
                    ui.set_status_text("A área de transferência não contém uma URL válida (http/https).".into());
                }
            }
            Err(_) => {
                ui.set_status_text("Não foi possível acessar a área de transferência.".into());
            }
        }
    });

    // 2. Limpar Vídeo Selecionado (Botão X)
    let handle = main_window.as_weak();
    let qualities_state = current_qualities.clone();
    main_window.on_clear_video_info(move || {
        if let Some(ui) = handle.upgrade() {
            ui.set_has_video_info(false);
            ui.set_download_url("".into());
            ui.set_status_text("Pronto para iniciar.".into());
            qualities_state.lock().unwrap().clear();
        }
    });

    // 3. Selecionar e Persistir Pasta de Download
    let handle = main_window.as_weak();
    let app_settings = settings.clone();
    main_window.on_browse_download_folder(move || {
        let folder = rfd::FileDialog::new().pick_folder();
        if let Some(path) = folder {
            if let Some(ui) = handle.upgrade() {
                let path_str = path.to_string_lossy().to_string();
                ui.set_download_output(path_str.clone().into());

                let mut s = app_settings.lock().unwrap();
                s.download_dir = path_str;
                s.save();
            }
        }
    });

    // 4. Consultar Metadados e Resoluções com yt-dlp
    let handle = main_window.as_weak();
    let qualities_state = current_qualities.clone();
    main_window.on_fetch_metadata(move |url| {
        let url_str = url.to_string();
        let ui_handle = handle.clone();
        let q_state = qualities_state.clone();

        if let Some(ui) = ui_handle.upgrade() {
            ui.set_status_text("Consultando qualidades disponíveis com yt-dlp...".into());
            ui.set_log_text(format!("Obtendo informações de: {}", url_str).into());
            ui.set_is_busy(true);
        }

        tokio::spawn(async move {
            match downloader::fetch_video_metadata(&url_str).await {
                Ok(meta) => {
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(ui) = ui_handle.upgrade() {
                            ui.set_is_busy(false);
                            ui.set_has_video_info(true);
                            ui.set_video_title(meta.title.into());
                            if let Some(dur) = meta.duration {
                                let min = dur / 60;
                                let sec = dur % 60;
                                ui.set_video_duration(format!("{:02}:{:02}", min, sec).into());
                            } else {
                                ui.set_video_duration("".into());
                            }

                            let names: Vec<slint::SharedString> = meta
                                .qualities
                                .iter()
                                .map(|q| q.name.clone().into())
                                .collect();

                            *q_state.lock().unwrap() = meta.qualities;

                            let model = std::rc::Rc::new(VecModel::from(names));
                            ui.set_quality_options(ModelRc::from(model));
                            ui.set_selected_quality_index(0);
                            ui.set_status_text("Vídeo carregado! Escolha as opções e clique em Baixar.".into());
                            ui.set_log_text("".into());
                        }
                    });
                }
                Err(err) => {
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(ui) = ui_handle.upgrade() {
                            ui.set_is_busy(false);
                            ui.set_status_text(format!("Erro ao verificar vídeo: {}", err).into());
                            ui.set_log_text(err.into());
                        }
                    });
                }
            }
        });
    });

    // 5. Iniciar Download e Conversão para DaVinci (com Áudio Garantido)
    let handle = main_window.as_weak();
    let cancel = cancel_flag.clone();
    let app_settings = settings.clone();
    let qualities_state = current_qualities.clone();
    let last_file = last_file_path.clone();

    main_window.on_start_download(move || {
        let ui = match handle.upgrade() {
            Some(u) => u,
            None => return,
        };

        let url = ui.get_download_url().to_string();
        let out_str = ui.get_download_output().to_string();
        let keep_orig = ui.get_keep_original();
        let is_audio_only = ui.get_is_audio_only();
        let quality_idx = ui.get_selected_quality_index() as usize;

        if url.is_empty() || out_str.is_empty() {
            ui.set_status_text("Por favor, selecione uma pasta de destino válida.".into());
            return;
        }

        // Salvar preferências atualizadas
        {
            let mut s = app_settings.lock().unwrap();
            s.keep_original = keep_orig;
            s.save();
        }

        let quality = if is_audio_only {
            "audio".to_string()
        } else {
            let q_lock = qualities_state.lock().unwrap();
            if let Some(opt) = q_lock.get(quality_idx) {
                opt.value.clone()
            } else {
                "best".to_string()
            }
        };

        ui.set_is_busy(true);
        ui.set_progress_value(0.0);
        ui.set_last_converted_file("".into());
        ui.set_status_text("Iniciando download com yt-dlp...".into());
        cancel.store(false, Ordering::SeqCst);

        let ui_handle = handle.clone();
        let cancel_thread = cancel.clone();
        let output_dir = PathBuf::from(out_str);
        let last_file_clone = last_file.clone();

        tokio::spawn(async move {
            let temp_dir = std::env::temp_dir().join(format!("rconv_gui_{}", std::process::id()));
            let _ = tokio::fs::create_dir_all(&temp_dir).await;

            let ui_prog = ui_handle.clone();
            let dl_res = downloader::download_video(
                &url,
                &temp_dir,
                &quality,
                cancel_thread.clone(),
                move |pct, msg| {
                    let ui_h = ui_prog.clone();
                    let log = msg.to_string();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(ui) = ui_h.upgrade() {
                            ui.set_progress_value(pct * 0.5); // 0 a 50% é download
                            ui.set_log_text(log.into());
                        }
                    });
                },
            )
            .await;

            let downloaded_file = match dl_res {
                Ok(path) => path,
                Err(err) => {
                    let _ = tokio::fs::remove_dir_all(&temp_dir).await;
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(ui) = ui_handle.upgrade() {
                            ui.set_is_busy(false);
                            ui.set_status_text(format!("Erro no download: {}", err).into());
                        }
                    });
                    return;
                }
            };

            let _ = slint::invoke_from_event_loop({
                let ui_h = ui_handle.clone();
                move || {
                    if let Some(ui) = ui_h.upgrade() {
                        ui.set_status_text("Download concluído! Convertendo para DaVinci Resolve (.mov PCM)...".into());
                    }
                }
            });

            let final_mov = converter::generate_output_filename(&downloaded_file, &output_dir, None);
            let ui_conv = ui_handle.clone();

            let conv_res = converter::convert_file(
                &downloaded_file,
                &final_mov,
                None, // Mapeia todas as faixas de áudio
                &[],  // Sem áudio externo
                is_audio_only,
                cancel_thread.clone(),
                move |pct: f32, msg: &str| {
                    let ui_h = ui_conv.clone();
                    let log = msg.to_string();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(ui) = ui_h.upgrade() {
                            ui.set_progress_value(50.0 + (pct * 0.5)); // 50 a 100% é conversão
                            ui.set_log_text(log.into());
                        }
                    });
                },
            )
            .await;

            // Se solicitado manter original, move para a pasta final
            if keep_orig {
                let orig_dest = output_dir.join(downloaded_file.file_name().unwrap());
                let _ = tokio::fs::rename(&downloaded_file, &orig_dest).await;
            }

            let _ = tokio::fs::remove_dir_all(&temp_dir).await;

            let _ = slint::invoke_from_event_loop(move || {
                if let Some(ui) = ui_handle.upgrade() {
                    ui.set_is_busy(false);
                    match conv_res {
                        Ok(p) => {
                            let p_str = p.to_string_lossy().to_string();
                            *last_file_clone.lock().unwrap() = Some(p.clone());
                            ui.set_progress_value(100.0);
                            ui.set_last_converted_file(p_str.into());
                            ui.set_status_text(format!("✓ Pronto para DaVinci Resolve! Salvo em: {}", p.display()).into());
                            ui.set_log_text("".into());
                        }
                        Err(err) => {
                            ui.set_status_text(format!("Falha na conversão: {}", err).into());
                        }
                    }
                }
            });
        });
    });

    // 6. Cancelar Operação Ativa
    let cancel = cancel_flag.clone();
    let handle = main_window.as_weak();
    main_window.on_cancel_process(move || {
        cancel.store(true, Ordering::SeqCst);
        if let Some(ui) = handle.upgrade() {
            ui.set_status_text("Cancelamento solicitado pelo usuário...".into());
        }
    });

    // 7. Ações de Arquivos Locais com Detecção de Faixas de Áudio
    let handle = main_window.as_weak();
    let ext_tracks_input = external_tracks_state.clone();
    main_window.on_input_path_changed(move |path_str| {
        if let Some(ui) = handle.upgrade() {
            let path = std::path::Path::new(path_str.as_str());
            let is_dir = path.is_dir();
            ui.set_is_folder_input(is_dir);
            if is_dir {
                ext_tracks_input.lock().unwrap().clear();
                let empty_model = std::rc::Rc::new(VecModel::<ExternalTrackEntry>::default());
                ui.set_external_tracks(ModelRc::from(empty_model));
            }
        }
    });

    let handle = main_window.as_weak();
    let audio_tracks_state = available_audio_tracks.clone();
    main_window.on_browse_input_file(move || {
        let file = rfd::FileDialog::new()
            .add_filter("Vídeos", converter::SUPPORTED_EXTENSIONS)
            .pick_file();

        if let Some(path) = file {
            if let Some(ui) = handle.upgrade() {
                let path_str = path.to_string_lossy().to_string();
                ui.set_input_path(path_str.into());
                ui.set_is_folder_input(false);

                if let Some(parent) = path.parent() {
                    ui.set_output_path(parent.to_string_lossy().to_string().into());
                }

                // Detectar faixas de áudio via ffprobe
                let ui_h = handle.clone();
                let a_state = audio_tracks_state.clone();
                tokio::spawn(async move {
                    if let Ok(tracks) = converter::get_audio_tracks(&path).await {
                        let mut entries = Vec::new();
                        for (i, t) in tracks.iter().enumerate() {
                            let lang_str = t.language.as_deref().unwrap_or("padrão");
                            let channels_str = format!("{} canais", t.channels.unwrap_or(2));
                            entries.push(AudioTrackEntry {
                                index: t.index as i32,
                                display_index: (i + 1) as i32,
                                label: format!("Faixa {}: [{} {}]", i + 1, t.codec_name, lang_str).into(),
                                codec: t.codec_name.to_uppercase().into(),
                                channels: channels_str.into(),
                                selected: true,
                            });
                        }

                        *a_state.lock().unwrap() = entries.clone();

                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(ui) = ui_h.upgrade() {
                                ui.set_select_all_audio(true);
                                let model = std::rc::Rc::new(VecModel::from(entries));
                                ui.set_audio_tracks(ModelRc::from(model));
                            }
                        });
                    }
                });
            }
        }
    });

    let handle = main_window.as_weak();
    let audio_tracks_folder = available_audio_tracks.clone();
    let ext_tracks_folder = external_tracks_state.clone();
    main_window.on_browse_input_folder(move || {
        let folder = rfd::FileDialog::new().pick_folder();
        if let Some(path) = folder {
            if let Some(ui) = handle.upgrade() {
                let path_str = path.to_string_lossy().to_string();
                ui.set_input_path(path_str.clone().into());
                ui.set_output_path(path_str.into());
                ui.set_is_folder_input(true);

                ext_tracks_folder.lock().unwrap().clear();
                let empty_ext = std::rc::Rc::new(VecModel::<ExternalTrackEntry>::default());
                ui.set_external_tracks(ModelRc::from(empty_ext));

                // Pastas não possuem faixas individuais: limpa a lista para ocultar a seção de áudio
                let empty_model = std::rc::Rc::new(VecModel::<AudioTrackEntry>::default());
                ui.set_audio_tracks(ModelRc::from(empty_model));
                *audio_tracks_folder.lock().unwrap() = Vec::new();
            }
        }
    });

    let handle = main_window.as_weak();
    let app_settings = settings.clone();
    main_window.on_browse_output_folder(move || {
        let folder = rfd::FileDialog::new().pick_folder();
        if let Some(path) = folder {
            if let Some(ui) = handle.upgrade() {
                let path_str = path.to_string_lossy().to_string();
                ui.set_output_path(path_str.clone().into());

                let mut s = app_settings.lock().unwrap();
                s.output_dir = path_str;
                s.save();
            }
        }
    });

    let handle = main_window.as_weak();
    main_window.on_create_output_folder(move || {
        if let Some(ui) = handle.upgrade() {
            let base_str = ui.get_output_path().to_string();
            let base = if base_str.is_empty() {
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
            } else {
                PathBuf::from(base_str)
            };

            let out_folder = base.join("rconv-output");
            let _ = std::fs::create_dir_all(&out_folder);
            ui.set_output_path(out_folder.to_string_lossy().to_string().into());
            ui.set_status_text("Pasta rconv-output criada com sucesso.".into());
        }
    });

    // 8. Callbacks de seleção multi-faixa de áudio
    let handle = main_window.as_weak();
    let a_state = available_audio_tracks.clone();
    main_window.on_toggle_audio_track(move |target_index| {
        let mut list = a_state.lock().unwrap();
        let mut all_checked = true;
        for item in list.iter_mut() {
            if item.index == target_index {
                item.selected = !item.selected;
            }
            if !item.selected {
                all_checked = false;
            }
        }
        let updated = list.clone();
        let _ = slint::invoke_from_event_loop({
            let ui_h = handle.clone();
            move || {
                if let Some(ui) = ui_h.upgrade() {
                    ui.set_select_all_audio(all_checked);
                    let model = std::rc::Rc::new(VecModel::from(updated));
                    ui.set_audio_tracks(ModelRc::from(model));
                }
            }
        });
    });

    let handle = main_window.as_weak();
    let a_state = available_audio_tracks.clone();
    main_window.on_toggle_all_audio_tracks(move |select_all| {
        let mut list = a_state.lock().unwrap();
        for item in list.iter_mut() {
            item.selected = select_all;
        }
        let updated = list.clone();
        let _ = slint::invoke_from_event_loop({
            let ui_h = handle.clone();
            move || {
                if let Some(ui) = ui_h.upgrade() {
                    ui.set_select_all_audio(select_all);
                    let model = std::rc::Rc::new(VecModel::from(updated));
                    ui.set_audio_tracks(ModelRc::from(model));
                }
            }
        });
    });

    // 8. Callbacks de Faixas de Áudio Externas & Alinhamento por Ondas
    let handle = main_window.as_weak();
    let ext_state = external_tracks_state.clone();
    let track_id_gen = next_track_id.clone();
    let v_tracks_ref = available_audio_tracks.clone();
    main_window.on_add_external_audio(move || {
        let files = rfd::FileDialog::new()
            .add_filter("Áudios e Vídeos", aligner::SUPPORTED_AUDIO_EXTENSIONS)
            .pick_files();

        if let Some(paths) = files {
            if let Some(ui) = handle.upgrade() {
                let (first_ref_idx, first_ref_label) = {
                    let list = v_tracks_ref.lock().unwrap();
                    if let Some(t) = list.iter().find(|t| t.selected).or_else(|| list.first()) {
                        (t.index, format!("Faixa {}", t.display_index))
                    } else {
                        (0, "Faixa 1".to_string())
                    }
                };

                let mut current = ext_state.lock().unwrap();
                for p in paths {
                    let id = track_id_gen.fetch_add(1, Ordering::SeqCst);
                    let fname = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let p_str = p.to_string_lossy().to_string();
                    current.push(ExternalTrackEntry {
                        id,
                        path: p_str.into(),
                        file_name: fname.into(),
                        ref_track_index: first_ref_idx,
                        ref_track_label: first_ref_label.clone().into(),
                        offset_seconds: 0.0,
                        offset_text: "0.000".into(),
                        align_status: "Aguardando alinhamento.".into(),
                        auto_align: true,
                        is_aligning: false,
                    });
                }

                let model = std::rc::Rc::new(VecModel::from(current.clone()));
                ui.set_external_tracks(ModelRc::from(model));
            }
        }
    });

    let handle = main_window.as_weak();
    let ext_state = external_tracks_state.clone();
    main_window.on_remove_external_audio(move |id| {
        let mut list = ext_state.lock().unwrap();
        list.retain(|t| t.id != id);
        let updated = list.clone();
        if let Some(ui) = handle.upgrade() {
            let model = std::rc::Rc::new(VecModel::from(updated));
            ui.set_external_tracks(ModelRc::from(model));
        }
    });

    let handle = main_window.as_weak();
    let ext_state = external_tracks_state.clone();
    let v_tracks_ref = available_audio_tracks.clone();
    main_window.on_cycle_track_reference(move |id| {
        let v_list = v_tracks_ref.lock().unwrap().clone();
        if v_list.is_empty() {
            return;
        }

        let mut list = ext_state.lock().unwrap();
        if let Some(track) = list.iter_mut().find(|t| t.id == id) {
            let current_pos = v_list.iter().position(|vt| vt.index == track.ref_track_index).unwrap_or(0);
            let next_pos = (current_pos + 1) % v_list.len();
            let next_track = &v_list[next_pos];

            track.ref_track_index = next_track.index;
            track.ref_track_label = format!("Faixa {}", next_track.display_index).into();
            track.align_status = format!("Referência: Faixa {}. Clique para alinhar.", next_track.display_index).into();
        }

        let updated = list.clone();
        if let Some(ui) = handle.upgrade() {
            let model = std::rc::Rc::new(VecModel::from(updated));
            ui.set_external_tracks(ModelRc::from(model));
        }
    });

    let handle = main_window.as_weak();
    let ext_state = external_tracks_state.clone();
    main_window.on_toggle_track_auto_align(move |id, val| {
        let mut list = ext_state.lock().unwrap();
        if let Some(track) = list.iter_mut().find(|t| t.id == id) {
            track.auto_align = val;
        }
        let updated = list.clone();
        if let Some(ui) = handle.upgrade() {
            let model = std::rc::Rc::new(VecModel::from(updated));
            ui.set_external_tracks(ModelRc::from(model));
        }
    });

    let handle = main_window.as_weak();
    let ext_state = external_tracks_state.clone();
    main_window.on_track_offset_changed(move |id, val| {
        let mut list = ext_state.lock().unwrap();
        if let Some(track) = list.iter_mut().find(|t| t.id == id) {
            track.offset_text = val.clone();
            if let Ok(num) = val.trim().parse::<f32>() {
                track.offset_seconds = num;
            }
        }
        let updated = list.clone();
        if let Some(ui) = handle.upgrade() {
            let model = std::rc::Rc::new(VecModel::from(updated));
            ui.set_external_tracks(ModelRc::from(model));
        }
    });

    let handle = main_window.as_weak();
    let ext_state = external_tracks_state.clone();
    main_window.on_run_track_alignment(move |id| {
        let ui = match handle.upgrade() {
            Some(u) => u,
            None => return,
        };

        let vid_path_str = ui.get_input_path().to_string();
        if vid_path_str.is_empty() {
            ui.set_status_text("Selecione o vídeo primeiro.".into());
            return;
        }

        let (ext_path_str, ref_track_idx, ref_label) = {
            let mut list = ext_state.lock().unwrap();
            let track = match list.iter_mut().find(|t| t.id == id) {
                Some(t) => t,
                None => return,
            };
            track.is_aligning = true;
            track.align_status = "Processando correlação cruzada via FFT...".into();
            (track.path.to_string(), track.ref_track_index as u32, track.ref_track_label.to_string())
        };

        let updated = ext_state.lock().unwrap().clone();
        let model = std::rc::Rc::new(VecModel::from(updated));
        ui.set_external_tracks(ModelRc::from(model));

        let ui_handle = handle.clone();
        let ext_state_clone = ext_state.clone();
        tokio::spawn(async move {
            let video_path = PathBuf::from(&vid_path_str);
            let ext_path = PathBuf::from(&ext_path_str);

            let res = aligner::align_external_audio(&video_path, ref_track_idx, &ext_path).await;

            let _ = slint::invoke_from_event_loop(move || {
                let mut list = ext_state_clone.lock().unwrap();
                if let Some(track) = list.iter_mut().find(|t| t.id == id) {
                    track.is_aligning = false;
                    match res {
                        Ok(align_res) => {
                            let sec = align_res.offset_seconds;
                            let ms = (sec * 1000.0).round() as i64;
                            let msg = if sec >= 0.0 {
                                format!("Sincronizado ({})! +{:.3}s (+{}ms)", ref_label, sec, ms)
                            } else {
                                format!("Sincronizado ({})! -{:.3}s ({}ms)", ref_label, sec.abs(), ms)
                            };
                            track.align_status = msg.into();
                            track.offset_seconds = sec as f32;
                            track.offset_text = format!("{:.3}", sec).into();
                        }
                        Err(err) => {
                            track.align_status = format!("Falha: {}", err).into();
                        }
                    }
                }

                let updated = list.clone();
                if let Some(ui) = ui_handle.upgrade() {
                    let model = std::rc::Rc::new(VecModel::from(updated));
                    ui.set_external_tracks(ModelRc::from(model));
                }
            });
        });
    });

    // 9. Iniciar Conversão Local com Preservação de Subpastas e Faixas de Áudio
    let handle = main_window.as_weak();
    let cancel = cancel_flag.clone();
    let audio_tracks_state = available_audio_tracks.clone();
    let ext_tracks_state_conv = external_tracks_state.clone();
    let last_file = last_file_path.clone();

    main_window.on_start_conversion(move || {
        let ui = match handle.upgrade() {
            Some(u) => u,
            None => return,
        };

        let in_str = ui.get_input_path().to_string();
        let out_str = ui.get_output_path().to_string();
        let recursive = ui.get_recursive();
        let local_audio_only = ui.get_local_audio_only();

        if in_str.is_empty() || out_str.is_empty() {
            ui.set_status_text("Defina o caminho de entrada e saída primeiro.".into());
            return;
        }

        let input_path = PathBuf::from(in_str);
        let output_path = PathBuf::from(out_str);

        // Mapeamento das faixas de áudio selecionadas pelo usuário
        let selected_track_indices: Option<Vec<u32>> = {
            let list = audio_tracks_state.lock().unwrap();
            if list.is_empty() {
                None // Sem lista prévia (ex: pasta de entrada com múltiplos vídeos), mapeia todas
            } else {
                let any_unselected = list.iter().any(|t| !t.selected);
                if any_unselected {
                    let indices: Vec<u32> = list.iter()
                        .filter(|t| t.selected)
                        .map(|t| t.index as u32)
                        .collect();
                    Some(indices)
                } else {
                    None // Todas as faixas selecionadas: mapeia todas
                }
            }
        };

        let ext_tracks_snapshot = ext_tracks_state_conv.lock().unwrap().clone();

        ui.set_is_busy(true);
        ui.set_progress_value(0.0);
        ui.set_last_converted_file("".into());
        ui.set_status_text("Buscando vídeos...".into());
        cancel.store(false, Ordering::SeqCst);

        let ui_handle = handle.clone();
        let cancel_thread = cancel.clone();
        let last_file_clone = last_file.clone();

        tokio::spawn(async move {
            let files = converter::collect_video_files(&input_path, recursive);
            let total = files.len();

            if total == 0 {
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(ui) = ui_handle.upgrade() {
                        ui.set_is_busy(false);
                        ui.set_status_text("Nenhum vídeo suportado foi encontrado.".into());
                    }
                });
                return;
            }

            let mut completed = 0;
            let base_dir = if input_path.is_dir() { Some(input_path.as_path()) } else { None };

            for file in files {
                if cancel_thread.load(Ordering::SeqCst) {
                    break;
                }

                let out_file = converter::generate_output_filename(&file, &output_path, base_dir);
                let fname = file.file_name().unwrap_or_default().to_string_lossy().to_string();

                // Alinhamento de faixas externas que ainda não foram sincronizadas manualmente
                let mut ext_configs = Vec::new();
                for track in &ext_tracks_snapshot {
                    let mut offset = track.offset_seconds as f64;
                    if track.auto_align && offset.abs() < 0.001 {
                        let ui_h = ui_handle.clone();
                        let t_name = track.file_name.to_string();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(ui) = ui_h.upgrade() {
                                ui.set_status_text(format!("Alinhando formas de onda ({}) via FFT...", t_name).into());
                            }
                        });

                        if let Ok(align_res) = aligner::align_external_audio(&file, track.ref_track_index as u32, &PathBuf::from(track.path.as_str())).await {
                            offset = align_res.offset_seconds;
                        }
                    }

                    ext_configs.push(converter::ExternalAudioConfig {
                        path: PathBuf::from(track.path.as_str()),
                        offset_seconds: offset,
                    });
                }

                let ui_prog = ui_handle.clone();
                let fname_clone = fname.clone();
                let track_slice = selected_track_indices.as_deref();

                let res = converter::convert_file(
                    &file,
                    &out_file,
                    track_slice,
                    &ext_configs,
                    local_audio_only,
                    cancel_thread.clone(),
                    move |pct, status| {
                        let ui_h = ui_prog.clone();
                        let msg = format!("{}: {}", fname_clone, status);
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(ui) = ui_h.upgrade() {
                                ui.set_progress_value(pct);
                                ui.set_log_text(msg.into());
                            }
                        });
                    },
                )
                .await;

                match res {
                    Ok(p) => {
                        completed += 1;
                        *last_file_clone.lock().unwrap() = Some(p.clone());
                        let ui_h = ui_handle.clone();
                        let current_total = total;
                        let current_comp = completed;
                        let p_str = p.to_string_lossy().to_string();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(ui) = ui_h.upgrade() {
                                let overall = (current_comp as f32 / current_total as f32) * 100.0;
                                ui.set_progress_value(overall);
                                ui.set_last_converted_file(p_str.into());
                                ui.set_status_text(
                                    format!("Convertido ({}/{}): {}", current_comp, current_total, fname).into(),
                                );
                            }
                        });
                    }
                    Err(err) => {
                        let ui_h = ui_handle.clone();
                        let first_line = err.lines().next().unwrap_or(&err).to_string();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(ui) = ui_h.upgrade() {
                                ui.set_status_text(format!("Falha em {}: {}", fname, first_line).into());
                                ui.set_log_text(err.into());
                            }
                        });
                    }
                }
            }

            let _ = slint::invoke_from_event_loop(move || {
                if let Some(ui) = ui_handle.upgrade() {
                    ui.set_is_busy(false);
                    if cancel_thread.load(Ordering::SeqCst) {
                        ui.set_status_text("Conversão cancelada pelo usuário.".into());
                    } else if completed == total {
                        ui.set_progress_value(100.0);
                        ui.set_status_text(format!("✓ Sucesso! {} vídeo(s) convertidos para DaVinci Resolve.", completed).into());
                    } else {
                        ui.set_status_text(format!("Finalizado: {} de {} vídeos convertidos.", completed, total).into());
                    }
                }
            });
        });
    });

    // 9. Abrir Pasta de Destino no Gerenciador de Arquivos do Linux
    let handle = main_window.as_weak();
    main_window.on_open_output_folder(move || {
        if let Some(ui) = handle.upgrade() {
            let active_nav = ui.get_active_nav();
            let path_str = if active_nav == 0 {
                ui.get_download_output().to_string()
            } else {
                ui.get_output_path().to_string()
            };

            if !path_str.is_empty() {
                let _ = open::that(&path_str);
            }
        }
    });

    // 10. Abrir Vídeo Convertido no Player Padrão
    let last_file_open = last_file_path.clone();
    main_window.on_open_converted_file(move || {
        if let Some(path) = last_file_open.lock().unwrap().as_ref() {
            let _ = open::that(path);
        }
    });

    main_window.run()?;
    Ok(())
}
