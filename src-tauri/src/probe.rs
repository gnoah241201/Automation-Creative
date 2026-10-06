/// The video codec named in `ffmpeg -i` output, or `None` when it cannot be
/// stated with confidence.
///
/// `None` means "convert", so every doubt resolves to `None`:
/// - no video stream at all (audio only, a corrupt file, a missing one);
/// - several video streams that do not agree. The brief's first-match parser
///   answered `h264` for an mkv holding h264 then hevc, and a copy would have
///   carried the hevc stream along.
///
/// Lines look like `Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), ...`
/// or, in mpegts, `Stream #0:0[0x100]: Video: h264 ...`. The `Video: ` marker is
/// only trusted when it follows the stream id directly, so a metadata value
/// that happens to contain those words is not mistaken for a stream.
pub fn video_codec(stderr: &str) -> Option<String> {
    let mut found: Option<String> = None;
    for line in stderr.lines() {
        let Some(rest) = line.trim().strip_prefix("Stream #") else { continue };
        let Some((id, video)) = rest.split_once("Video: ") else { continue };
        if id.trim_end_matches(' ').contains(' ') {
            continue;
        }
        let Some(codec) = video.split([' ', ',']).next().filter(|c| !c.is_empty()) else { continue };
        match &found {
            None => found = Some(codec.to_string()),
            Some(first) if first == codec => {}
            Some(_) => return None,
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::video_codec;

    // Every sample below is real output of the bundled ffmpeg (4.1 build),
    // trimmed to the lines that matter.

    #[test]
    fn reads_h264_ahead_of_an_audio_stream() {
        let text = r#"Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'h264.mp4':
  Duration: 00:00:01.02, start: 0.000000, bitrate: 112 kb/s
    Stream #0:0(und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p, 160x90 [SAR 1:1 DAR 16:9], 28 kb/s, 10 fps, 10 tbr, 10240 tbn, 20 tbc (default)
    Metadata:
      handler_name    : VideoHandler
    Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)
At least one output file must be specified"#;
        assert_eq!(video_codec(text).as_deref(), Some("h264"));
    }

    #[test]
    fn reads_hevc() {
        let text = "    Stream #0:0(und): Video: hevc (Rext) (hev1 / 0x31766568), gbrp(tv, gbr/unknown/unknown, progressive), 160x90 [SAR 1:1 DAR 16:9], 20 kb/s, 10 fps";
        assert_eq!(video_codec(text).as_deref(), Some("hevc"));
    }

    #[test]
    fn reads_the_mpegts_form_with_a_bracketed_pid() {
        let text = "    Stream #0:0[0x100]: Video: h264 (High 4:4:4 Predictive) ([27][0][0][0] / 0x001B), yuv444p(progressive), 160x90";
        assert_eq!(video_codec(text).as_deref(), Some("h264"));
    }

    #[test]
    fn reads_a_codec_that_ends_at_a_comma() {
        // webm / mkv print no parenthesised profile before the first comma.
        let text = "    Stream #0:0: Video: vp9, yuv420p, 160x90";
        assert_eq!(video_codec(text).as_deref(), Some("vp9"));
    }

    #[test]
    fn an_audio_only_file_has_no_codec() {
        let text = "    Stream #0:0(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)";
        assert_eq!(video_codec(text), None);
    }

    #[test]
    fn a_file_ffmpeg_could_not_open_has_no_codec() {
        let text = r#"[mov,mp4,m4a,3gp,3g2,mj2 @ 000001c193c1a440] moov atom not found
junk.mp4: Invalid data found when processing input"#;
        assert_eq!(video_codec(text), None);
        assert_eq!(video_codec("missing.mp4: No such file or directory"), None);
        assert_eq!(video_codec(""), None);
    }

    #[test]
    fn disagreeing_video_streams_are_not_trusted() {
        // h264 first, hevc second: copying this would ship the hevc stream.
        let text = r#"    Stream #0:0: Video: h264 (High 4:4:4 Predictive), yuv444p(progressive), 160x90 [SAR 1:1 DAR 16:9], 10 fps
    Stream #0:1: Video: hevc (Main), yuv420p(tv), 160x90 [SAR 1:1 DAR 16:9], 10 fps"#;
        assert_eq!(video_codec(text), None);
    }

    #[test]
    fn agreeing_video_streams_are_fine() {
        let text = r#"    Stream #0:0(und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p, 160x90
    Stream #0:1(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 160x90"#;
        assert_eq!(video_codec(text).as_deref(), Some("h264"));
    }

    #[test]
    fn metadata_that_mentions_a_video_is_not_a_stream() {
        let text = r#"    Metadata:
      comment         : Stream #9: Video: hevc fake
    Stream #0:0: Video: h264 (High), yuv420p"#;
        assert_eq!(video_codec(text).as_deref(), Some("h264"));
    }
}
