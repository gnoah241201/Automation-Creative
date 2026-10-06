/// What `ffmpeg -i` says about a file: the video codec and the container.
///
/// Both are `None` when they cannot be stated with confidence, and the caller
/// treats `None` as "convert". A file is only copied when it is h264 inside an
/// mp4-family container; a codec alone is half the answer, because h264 in a
/// transport stream or matroska keeps that container when it is byte-copied
/// and renamed `.mp4`, and still will not open on anyone else's machine.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct MediaProbe {
    pub codec: Option<String>,
    pub container: Option<String>,
}

pub fn media(stderr: &str) -> MediaProbe {
    MediaProbe { codec: video_codec(stderr), container: container(stderr) }
}

/// The demuxer list from the `Input #0, <demuxers>, from '<path>':` line.
///
/// Read from ffmpeg's own demuxer choice rather than the file extension: an
/// `.mp4` that is really matroska would fool an extension check. The mp4
/// family prints as one comma list, `mov,mp4,m4a,3gp,3g2,mj2`, which is also
/// what a `.mov`, `.3gp` or `.ismv` prints: this level cannot tell them apart.
///
/// `, from '` is searched for from the left, so a path that itself contains
/// those characters cannot shift the answer. Absent when the file could not be
/// opened, which is a case that converts.
pub fn container(stderr: &str) -> Option<String> {
    let rest = stderr.lines().find_map(|line| line.trim_start().strip_prefix("Input #"))?;
    let (_, after_index) = rest.split_once(", ")?;
    let (names, _) = after_index.split_once(", from '")?;
    if names.is_empty() || names.contains(' ') {
        return None;
    }
    Some(names.to_string())
}

/// The video codec named in `ffmpeg -i` output, or `None` when it cannot be
/// stated with confidence.
///
/// `None` means "convert", so every doubt resolves to `None`:
/// - no video stream at all (audio only, a corrupt file, a missing one);
/// - several video streams that do not agree. A first-match parser answered
///   `h264` for an mkv holding h264 then hevc, and a copy would have carried
///   the hevc stream along;
/// - a `Stream #... Video:` line whose shape is not the one ffmpeg prints. A
///   stream we cannot read is a stream we cannot vouch for, so it must not be
///   skipped as though it were absent.
///
/// Lines look like `Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), ...`
/// or, in mpegts, `Stream #0:0[0x100]: Video: h264 ...`. Only lines that begin
/// with `Stream #` are considered, so a metadata value that happens to contain
/// those words is not mistaken for a stream.
pub fn video_codec(stderr: &str) -> Option<String> {
    let mut found: Option<String> = None;
    for line in stderr.lines() {
        let Some(rest) = line.trim().strip_prefix("Stream #") else { continue };
        let Some((id, video)) = rest.split_once("Video: ") else { continue };
        if id.trim_end_matches(' ').contains(' ') {
            return None;
        }
        let Some(codec) = video.split([' ', ',']).next().filter(|c| !c.is_empty()) else {
            return None;
        };
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
    use super::{container, media, video_codec, MediaProbe};

    // Provenance. Samples marked REAL are lines copied from the bundled
    // ffmpeg's stderr (a 4.1 build); the only edit is that the quoted path in
    // an `Input` line is shortened. Samples marked SYNTHETIC were composed to
    // reach a branch that no file I could produce reaches, and prove only what
    // the code does with that shape, not what ffmpeg prints.

    #[test]
    fn reads_h264_ahead_of_an_audio_stream() {
        // REAL: h264 mp4 with an aac track.
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
        // REAL: hevc mp4.
        let text = "    Stream #0:0(und): Video: hevc (Rext) (hev1 / 0x31766568), gbrp(tv, gbr/unknown/unknown, progressive), 160x90 [SAR 1:1 DAR 16:9], 20 kb/s, 10 fps, 10 tbr, 10240 tbn, 10 tbc (default)";
        assert_eq!(video_codec(text).as_deref(), Some("hevc"));
    }

    #[test]
    fn reads_the_mpegts_form_with_a_bracketed_pid() {
        // REAL: h264 in a .ts file.
        let text = "    Stream #0:0[0x100]: Video: h264 (High 4:4:4 Predictive) ([27][0][0][0] / 0x001B), yuv444p(progressive), 160x90 [SAR 1:1 DAR 16:9], 10 fps, 10 tbr, 90k tbn, 20 tbc";
        assert_eq!(video_codec(text).as_deref(), Some("h264"));
    }

    #[test]
    fn reads_a_codec_that_ends_at_a_comma() {
        // REAL: what ffmpeg's tty demuxer prints for a plain text file.
        let text = "    Stream #0:0: Video: ansi, pal8, 640x400, 25 fps, 25 tbr, 25 tbn, 25 tbc";
        assert_eq!(video_codec(text).as_deref(), Some("ansi"));
    }

    #[test]
    fn an_audio_only_file_has_no_codec() {
        // REAL: aac in an m4a.
        let text = "    Stream #0:0(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)";
        assert_eq!(video_codec(text), None);
    }

    #[test]
    fn a_file_ffmpeg_could_not_open_has_no_codec() {
        // REAL: 5000 random bytes named .mp4, then a path that does not exist.
        let text = r#"[mov,mp4,m4a,3gp,3g2,mj2 @ 000001c193c1a440] moov atom not found
junk.mp4: Invalid data found when processing input"#;
        assert_eq!(video_codec(text), None);
        assert_eq!(video_codec("missing.mp4: No such file or directory"), None);
        // SYNTHETIC: no output at all.
        assert_eq!(video_codec(""), None);
    }

    #[test]
    fn disagreeing_video_streams_are_not_trusted() {
        // REAL: an mkv built with h264 first, hevc second. Copying this would
        // ship the hevc stream.
        let text = r#"    Stream #0:0: Video: h264 (High 4:4:4 Predictive), yuv444p(progressive), 160x90 [SAR 1:1 DAR 16:9], 10 fps, 10 tbr, 1k tbn, 20 tbc (default)
    Stream #0:1: Video: hevc (Main), yuv420p(tv), 160x90 [SAR 1:1 DAR 16:9], 10 fps, 10 tbr, 1k tbn, 10 tbc (default)"#;
        assert_eq!(video_codec(text), None);
    }

    #[test]
    fn agreeing_video_streams_are_fine() {
        // REAL: an mp4 with two h264 video streams of different profiles.
        let text = r#"    Stream #0:0(und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p, 160x90 [SAR 1:1 DAR 16:9], 28 kb/s, 10 fps, 10 tbr, 10240 tbn, 20 tbc (default)
    Stream #0:1(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 160x90 [SAR 1:1 DAR 16:9], 81 kb/s, 10 fps, 10 tbr, 10240 tbn, 20 tbc"#;
        assert_eq!(video_codec(text).as_deref(), Some("h264"));
    }

    #[test]
    fn metadata_that_mentions_a_video_is_not_a_stream() {
        // SYNTHETIC. The metadata line is skipped at the `Stream #` prefix
        // check, before the shape check below is ever reached.
        let text = r#"    Metadata:
      comment         : Stream #9: Video: hevc fake
    Stream #0:0: Video: h264 (High), yuv420p"#;
        assert_eq!(video_codec(text).as_deref(), Some("h264"));
    }

    #[test]
    fn a_video_stream_line_of_an_unknown_shape_is_doubt_not_absence() {
        // SYNTHETIC. No real file reached this: a stream line whose id holds
        // a space. Skipping it would let an unreadable stream pass unseen
        // beside a readable h264 one, so it must give up instead.
        let text = r#"    Stream #0:0: Video: h264 (High), yuv420p
    Stream #0:1 odd id: Video: hevc (Main), yuv420p"#;
        assert_eq!(video_codec(text), None);
        // SYNTHETIC: the marker with no codec after it.
        assert_eq!(video_codec("    Stream #0:0: Video: "), None);
    }

    #[test]
    fn reads_the_mp4_family_as_one_comma_list() {
        // REAL: the same line for .mp4, .mov, .3gp, .ismv, a fragmented mp4
        // and an m4a. ffmpeg's mov demuxer does not distinguish them.
        let text = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'h264.mp4':\n  Metadata:";
        assert_eq!(container(text).as_deref(), Some("mov,mp4,m4a,3gp,3g2,mj2"));
    }

    #[test]
    fn reads_other_containers_by_what_ffmpeg_detected() {
        // REAL, one line each: matroska (.mkv), mpegts (.ts), avi, flv, tty.
        assert_eq!(container("Input #0, matroska,webm, from 'h264.mkv':").as_deref(), Some("matroska,webm"));
        assert_eq!(container("Input #0, mpegts, from 'h264.ts':").as_deref(), Some("mpegts"));
        assert_eq!(container("Input #0, avi, from 'h264.avi':").as_deref(), Some("avi"));
        assert_eq!(container("Input #0, flv, from 'h264.flv':").as_deref(), Some("flv"));
        assert_eq!(container("Input #0, tty, from 'notes.txt':").as_deref(), Some("tty"));
    }

    #[test]
    fn the_container_follows_the_demuxer_not_the_extension() {
        // REAL: h264 written as matroska and as mpegts, both named .mp4.
        assert_eq!(container("Input #0, matroska,webm, from 'mkv_named.mp4':").as_deref(), Some("matroska,webm"));
        assert_eq!(container("Input #0, mpegts, from 'ts_named.mp4':").as_deref(), Some("mpegts"));
    }

    #[test]
    fn a_file_ffmpeg_could_not_open_has_no_container() {
        // REAL: the corrupt-file output has no Input line at all.
        let text = r#"[mov,mp4,m4a,3gp,3g2,mj2 @ 000001c193c1a440] moov atom not found
junk.mp4: Invalid data found when processing input"#;
        assert_eq!(container(text), None);
        assert_eq!(container("missing.mp4: No such file or directory"), None);
        // SYNTHETIC: no output at all.
        assert_eq!(container(""), None);
    }

    #[test]
    fn a_path_containing_the_delimiter_does_not_shift_the_container() {
        // SYNTHETIC: a file literally named `a, from 'b.mkv`.
        assert_eq!(container("Input #0, matroska,webm, from 'a, from 'b.mkv':").as_deref(), Some("matroska,webm"));
    }

    #[test]
    fn media_reports_both_halves() {
        // REAL lines, assembled: h264 inside mpegts.
        let text = "Input #0, mpegts, from 'h264.ts':\n    Stream #0:0[0x100]: Video: h264 (High 4:4:4 Predictive) ([27][0][0][0] / 0x001B), yuv444p(progressive), 160x90";
        assert_eq!(
            media(text),
            MediaProbe { codec: Some("h264".into()), container: Some("mpegts".into()) }
        );
    }
}
