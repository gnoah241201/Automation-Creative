/// What `ffmpeg -i` says about a file: the video codec, the container, the
/// audio, and the length and picture size.
///
/// The length and size exist because the webview cannot always read them: a
/// file in a codec WebView2 cannot decode (HEVC on a machine without the
/// extension) reports no duration or dimensions to a `<video>`, yet ffmpeg
/// reads both. They are a fallback, never a guess: each is `None` unless
/// ffmpeg printed it unambiguously.
///
/// Both are `None` when they cannot be stated with confidence, and the caller
/// treats `None` as "convert". A file is only copied when it is h264 inside an
/// mp4-family container; a codec alone is half the answer, because h264 in a
/// transport stream or matroska keeps that container when it is byte-copied
/// and renamed `.mp4`, and still will not open on anyone else's machine.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub codec: Option<String>,
    pub container: Option<String>,
    /// How many `Audio:` streams ffmpeg listed. A fact, not a judgement: `0`
    /// is a silent file, which is fine to copy. It exists because
    /// `audio_codec` alone cannot tell a silent file from one whose audio could
    /// not be read, and those two must not be treated alike.
    pub audio_streams: u32,
    /// The audio codec: `Some` only when there is at least one audio stream,
    /// every one of them is readable, and they all agree. `None` means silent
    /// or cannot tell; `audio_streams` says which.
    pub audio_codec: Option<String>,
    /// Seconds, from the `Duration:` line. `None` for `N/A` or no such line.
    pub duration: Option<f64>,
    /// Picture size as a viewer sees it: already swapped for a 90/270 degree
    /// rotation. `None` unless every video stream agrees.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub fn media(stderr: &str) -> MediaProbe {
    let size = video_size(stderr);
    MediaProbe {
        codec: video_codec(stderr),
        container: container(stderr),
        audio_streams: audio_stream_count(stderr),
        audio_codec: audio_codec(stderr),
        duration: duration_seconds(stderr),
        width: size.map(|(w, _)| w),
        height: size.map(|(_, h)| h),
    }
}

/// The length from the `  Duration: 00:00:03.00, start: ...` line.
///
/// Only a line that BEGINS with `Duration: ` counts, so a metadata value that
/// mentions one (mkv stores a `DURATION` tag, upper case, with spaces before
/// the colon) is never read. `N/A` (live streams, some broken files) and a
/// zero length are `None`: a length that cannot gate a tier is not a length.
pub fn duration_seconds(stderr: &str) -> Option<f64> {
    let rest = stderr.lines().find_map(|line| line.trim_start().strip_prefix("Duration: "))?;
    let stamp = rest.split(',').next()?.trim();
    let mut parts = stamp.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let total = hours * 3600.0 + minutes * 60.0 + seconds;
    (total.is_finite() && total > 0.0).then_some(total)
}

/// `WIDTHxHEIGHT` from the text after `Video: `, skipping hex such as
/// `0x31637668` (a codec tag, which also has digits either side of an `x`).
fn dimensions(text: &str) -> Option<(u32, u32)> {
    let bytes = text.as_bytes();
    for (at, byte) in bytes.iter().enumerate() {
        if *byte != b'x' || at == 0 || at + 1 >= bytes.len() {
            continue;
        }
        if !bytes[at - 1].is_ascii_digit() || !bytes[at + 1].is_ascii_digit() {
            continue;
        }
        let mut start = at;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        let mut end = at + 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        let before_ok = start == 0 || bytes[start - 1] == b' ';
        let after_ok = end == bytes.len() || matches!(bytes[end], b' ' | b',' | b'[');
        if !before_ok || !after_ok || bytes[start] == b'0' {
            continue;
        }
        let width: u32 = text[start..at].parse().ok()?;
        let height: u32 = text[at + 1..end].parse().ok()?;
        if width > 0 && height > 0 {
            return Some((width, height));
        }
    }
    None
}

/// Degrees of rotation printed under a video stream, from either the
/// `displaymatrix: rotation of -90.00 degrees` side data or a `rotate : 90` tag.
/// The side data wins when both are present; the tag's sign is not reliable
/// (a stream tagged `rotate : 270` printed a display matrix of 90).
fn rotation_degrees(block: &[&str]) -> Option<f64> {
    let from_matrix = block.iter().find_map(|line| {
        let rest = line.trim().strip_prefix("displaymatrix: rotation of ")?;
        rest.split(' ').next()?.parse::<f64>().ok()
    });
    from_matrix.or_else(|| {
        block.iter().find_map(|line| {
            let rest = line.trim().strip_prefix("rotate")?;
            let (_, value) = rest.split_once(':')?;
            value.trim().parse::<f64>().ok()
        })
    })
}

/// The picture size a viewer sees, or `None` when it cannot be stated.
///
/// Every video stream must agree. Cover art is a second video stream of a
/// different size, and picking either would label the file by a thumbnail or
/// by a guess. A 90/270 degree rotation swaps the two numbers, because that is
/// the shape the file plays in and the shape its outputs are composed from.
pub fn video_size(stderr: &str) -> Option<(u32, u32)> {
    let lines: Vec<&str> = stderr.lines().collect();
    let mut sizes: Vec<(u32, u32)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(rest) = line.trim().strip_prefix("Stream #") else { continue };
        let Some((_, video)) = rest.split_once("Video: ") else { continue };
        let (width, height) = dimensions(video)?;
        let block: Vec<&str> = lines[index + 1..]
            .iter()
            .copied()
            .take_while(|next| !next.trim().starts_with("Stream #"))
            .collect();
        let turned = rotation_degrees(&block).map(|d| (d.abs().round() as i64) % 180 == 90).unwrap_or(false);
        sizes.push(if turned { (height, width) } else { (width, height) });
    }
    let first = *sizes.first()?;
    sizes.iter().all(|size| *size == first).then_some(first)
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

/// How many audio streams `ffmpeg -i` listed. Same line rule as the codec
/// readers: only lines that begin with `Stream #` count.
pub fn audio_stream_count(stderr: &str) -> u32 {
    stderr
        .lines()
        .filter(|line| {
            line.trim().strip_prefix("Stream #").is_some_and(|rest| rest.contains("Audio:"))
        })
        .count() as u32
}

/// The audio codec named in `ffmpeg -i` output, or `None` when there is none
/// to state.
///
/// The same discipline as `video_codec`, because the same incident is
/// reachable through the audio stream: an h264 mp4 carrying AMR or PCM audio
/// opens on nobody's machine once it is byte-copied. So:
/// - no audio stream gives `None` (the caller reads `audio_stream_count` to
///   learn that this is silence and not doubt);
/// - several audio streams that do not agree give `None`, because a copy would
///   carry the odd one along;
/// - an `Audio:` line whose shape is not the one ffmpeg prints gives `None`,
///   not a skip: a stream we cannot read is a stream we cannot vouch for.
///
/// Lines look like `Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), ...`.
pub fn audio_codec(stderr: &str) -> Option<String> {
    let mut found: Option<String> = None;
    for line in stderr.lines() {
        let Some(rest) = line.trim().strip_prefix("Stream #") else { continue };
        let Some((id, audio)) = rest.split_once("Audio:") else { continue };
        if id.trim_end_matches(' ').contains(' ') {
            return None;
        }
        let Some(codec) = audio.trim_start().split([' ', ',']).next().filter(|c| !c.is_empty()) else {
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
    use super::{
        audio_codec, audio_stream_count, container, duration_seconds, media, video_codec, video_size,
        MediaProbe,
    };

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
            MediaProbe {
                codec: Some("h264".into()),
                container: Some("mpegts".into()),
                audio_streams: 0,
                audio_codec: None,
                duration: None,
                width: Some(160),
                height: Some(90),
            }
        );
    }

    // Duration and size. REAL samples are stderr captured from the bundled
    // ffmpeg for files generated here.

    const LANDSCAPE_HEVC: &str = r#"Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'land_hevc.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2mp41
    encoder         : Lavf58.24.101
  Duration: 00:00:03.00, start: 0.000000, bitrate: 1497 kb/s
    Stream #0:0(und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, progressive), 1280x720 [SAR 1:1 DAR 16:9], 1487 kb/s, 25 fps, 25 tbr, 12800 tbn, 25 tbc (default)
    Metadata:
      handler_name    : VideoHandler
At least one output file must be specified"#;

    #[test]
    fn a_landscape_hevc_file_reports_its_length_and_true_shape() {
        // REAL. The case this exists for: a webview that cannot decode hevc
        // reports neither, and the codec tag `0x31637668` must not be read as a size.
        assert_eq!(duration_seconds(LANDSCAPE_HEVC), Some(3.0));
        assert_eq!(video_size(LANDSCAPE_HEVC), Some((1280, 720)));
        let probe = media(LANDSCAPE_HEVC);
        assert_eq!((probe.codec.as_deref(), probe.width, probe.height), (Some("hevc"), Some(1280), Some(720)));
    }

    #[test]
    fn a_portrait_file_stays_portrait() {
        // REAL: h264 360x640.
        let text = r#"  Duration: 00:00:02.00, start: 0.000000, bitrate: 48 kb/s
    Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 360x640 [SAR 1:1 DAR 9:16], 44 kb/s, 10 fps, 10 tbr, 10240 tbn, 20 tbc (default)
    Metadata:
      handler_name    : VideoHandler"#;
        assert_eq!(video_size(text), Some((360, 640)));
        assert_eq!(duration_seconds(text), Some(2.0));
    }

    #[test]
    fn a_rotated_file_is_reported_in_the_shape_it_plays_in() {
        // REAL: the same 360x640 stream remuxed with `-metadata:s:v:0 rotate=90`.
        // Note the tag reads 270 while the display matrix reads 90: the matrix is
        // what is trusted, and either value is a quarter turn.
        let text = r#"  Duration: 00:00:02.00, start: 0.000000, bitrate: 48 kb/s
    Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 360x640 [SAR 1:1 DAR 9:16], 44 kb/s, 10 fps, 10 tbr, 10240 tbn, 20 tbc (default)
    Metadata:
      rotate          : 270
      handler_name    : VideoHandler
    Side data:
      displaymatrix: rotation of 90.00 degrees
At least one output file must be specified"#;
        assert_eq!(video_size(text), Some((640, 360)));
    }

    #[test]
    fn a_tag_alone_turns_the_picture_too() {
        // SYNTHETIC: an older ffmpeg prints only the tag.
        let text = "    Stream #0:0: Video: h264 (High), yuv420p, 360x640 [SAR 1:1 DAR 9:16], 10 fps\n    Metadata:\n      rotate          : 90";
        assert_eq!(video_size(text), Some((640, 360)));
    }

    #[test]
    fn a_half_turn_does_not_swap() {
        // SYNTHETIC: 180 degrees is upside down, not sideways.
        let text = "    Stream #0:0: Video: h264 (High), yuv420p, 360x640, 10 fps\n    Side data:\n      displaymatrix: rotation of 180.00 degrees";
        assert_eq!(video_size(text), Some((360, 640)));
    }

    #[test]
    fn a_negative_quarter_turn_swaps() {
        // SYNTHETIC: ffmpeg prints -90 for the other direction.
        let text = "    Stream #0:0: Video: h264 (High), yuv420p, 360x640, 10 fps\n    Side data:\n      displaymatrix: rotation of -90.00 degrees";
        assert_eq!(video_size(text), Some((640, 360)));
    }

    #[test]
    fn a_rotation_under_a_later_stream_does_not_turn_an_earlier_one() {
        // SYNTHETIC: the rotation belongs to the stream whose block it sits in.
        let text = "    Stream #0:0: Video: h264 (High), yuv420p, 360x640, 10 fps\n    Stream #0:1: Audio: aac (LC), 44100 Hz, mono\n    Side data:\n      displaymatrix: rotation of 90.00 degrees";
        assert_eq!(video_size(text), Some((360, 640)));
    }

    #[test]
    fn a_matroska_file_named_mp4_reads_its_length_from_the_duration_line_not_the_tag() {
        // REAL: mkv stores a `DURATION` tag per stream, upper case, with spaces.
        let text = r#"Input #0, matroska,webm, from 'mkv_named.mp4':
  Metadata:
    ENCODER         : Lavf58.24.101
  Duration: 00:00:01.02, start: 0.000000, bitrate: 107 kb/s
    Stream #0:0: Video: h264 (High), yuv420p(progressive), 160x90 [SAR 1:1 DAR 16:9], 10 fps, 10 tbr, 1k tbn, 20 tbc (default)
    Metadata:
      ENCODER         : Lavc58.42.102 libx264
      DURATION        : 00:00:01.023000000
    Stream #0:1: Audio: aac (LC), 44100 Hz, mono, fltp (default)"#;
        assert_eq!(duration_seconds(text), Some(1.02));
        assert_eq!(video_size(text), Some((160, 90)));
    }

    #[test]
    fn a_file_ffmpeg_could_not_open_has_no_length_and_no_size() {
        // REAL: 5000 random bytes named .mp4.
        let text = "junk.mp4: Invalid data found when processing input";
        assert_eq!(duration_seconds(text), None);
        assert_eq!(video_size(text), None);
        assert_eq!(duration_seconds(""), None);
        assert_eq!(video_size(""), None);
    }

    #[test]
    fn hours_and_minutes_count() {
        // SYNTHETIC.
        assert_eq!(duration_seconds("  Duration: 01:02:03.50, start: 0.0"), Some(3723.5));
    }

    #[test]
    fn an_unknown_or_zero_length_is_none() {
        // SYNTHETIC: ffmpeg prints N/A for some live and broken inputs.
        assert_eq!(duration_seconds("  Duration: N/A, bitrate: N/A"), None);
        assert_eq!(duration_seconds("  Duration: 00:00:00.00, start: 0.0"), None);
        assert_eq!(duration_seconds("  Duration: 00:00, start: 0.0"), None);
    }

    #[test]
    fn a_metadata_value_that_mentions_a_duration_is_not_the_duration() {
        // SYNTHETIC.
        let text = "  Metadata:\n    comment         : Duration: 99:00:00.00, fake\n  Duration: 00:00:05.00, start: 0.0";
        assert_eq!(duration_seconds(text), Some(5.0));
    }

    #[test]
    fn video_streams_that_disagree_on_size_give_no_size() {
        // SYNTHETIC: a cover-art stream beside the picture. Picking either
        // would label the file by a thumbnail or by a guess.
        let text = "    Stream #0:0: Video: h264 (High), yuv420p, 1280x720, 25 fps\n    Stream #0:1: Video: h264 (High), yuv420p, 300x300, 25 fps";
        assert_eq!(video_size(text), None);
    }

    #[test]
    fn video_streams_that_agree_on_size_give_it() {
        // SYNTHETIC.
        let text = "    Stream #0:0: Video: h264 (High), yuv420p, 1280x720, 25 fps\n    Stream #0:1: Video: h264 (High), yuv420p, 1280x720, 25 fps";
        assert_eq!(video_size(text), Some((1280, 720)));
    }

    #[test]
    fn an_audio_only_file_has_a_length_but_no_size() {
        // REAL shape: aac in an m4a.
        let text = "  Duration: 00:00:01.02, start: 0.000000, bitrate: 112 kb/s\n    Stream #0:0(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)";
        assert_eq!(duration_seconds(text), Some(1.02));
        assert_eq!(video_size(text), None);
    }

    #[test]
    fn a_stream_line_with_no_readable_size_gives_no_size() {
        // SYNTHETIC: a video stream whose line carries no WxH. It is doubt, not absence.
        assert_eq!(video_size("    Stream #0:0: Video: h264 (High), yuv420p, 25 fps"), None);
    }

    #[test]
    fn a_hex_codec_tag_is_never_a_size() {
        // SYNTHETIC: the tag alone, no size after it.
        assert_eq!(video_size("    Stream #0:0: Video: hevc (Main) (hvc1 / 0x31637668), yuv420p, 25 fps"), None);
    }

    // Audio. Samples are stderr captured from the bundled ffmpeg (N-92722) for
    // files generated here. This build's mp4 muxer refuses PCM and AMR, so
    // those two were written as .mov and .3gp: ffmpeg prints the same
    // `mov,mp4,m4a,3gp,3g2,mj2` demuxer line for all three, which is why such
    // a file can be copied under an .mp4 name without anyone noticing.

    #[test]
    fn reads_aac_audio() {
        // REAL: h264 mp4 with an aac track.
        let text = "    Stream #0:0(und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p, 160x90 [SAR 1:1 DAR 16:9], 28 kb/s, 10 fps, 10 tbr, 10240 tbn, 20 tbc (default)\n    Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)";
        assert_eq!(audio_codec(text).as_deref(), Some("aac"));
        assert_eq!(audio_stream_count(text), 1);
    }

    #[test]
    fn reads_mp3_audio_in_an_mp4() {
        // REAL.
        let text = "    Stream #0:1(und): Audio: mp3 (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 65 kb/s (default)";
        assert_eq!(audio_codec(text).as_deref(), Some("mp3"));
    }

    #[test]
    fn reads_pcm_audio() {
        // REAL: h264 + pcm_s16le in a .mov (also what that file prints when renamed .mp4).
        let text = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'pcm.mov':\n    Stream #0:0(eng): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p, 160x90 [SAR 1:1 DAR 16:9], 28 kb/s, 10 fps, 10 tbr, 10240 tbn, 20 tbc (default)\n    Stream #0:1(eng): Audio: pcm_s16le (sowt / 0x74776F73), 44100 Hz, mono, s16, 705 kb/s (default)";
        assert_eq!(audio_codec(text).as_deref(), Some("pcm_s16le"));
        let probe = media(text);
        assert_eq!(probe.audio_codec.as_deref(), Some("pcm_s16le"));
        assert_eq!(probe.container.as_deref(), Some("mov,mp4,m4a,3gp,3g2,mj2"));
        assert_eq!(probe.codec.as_deref(), Some("h264"));
    }

    #[test]
    fn reads_amr_audio() {
        // REAL: h264 + amr_nb in a .3gp.
        let text = "    Stream #0:1(und): Audio: amr_nb (samr / 0x726D6173), 8000 Hz, mono, flt, 12 kb/s (default)";
        assert_eq!(audio_codec(text).as_deref(), Some("amr_nb"));
    }

    #[test]
    fn reads_opus_audio() {
        // REAL: h264 + opus in an mp4.
        let text = "    Stream #0:1(und): Audio: opus (Opus / 0x7375704F), 48000 Hz, mono, fltp, 72 kb/s (default)";
        assert_eq!(audio_codec(text).as_deref(), Some("opus"));
    }

    #[test]
    fn reads_the_matroska_form_with_no_language_tag() {
        // REAL: aac in an .mkv.
        let text = "    Stream #0:1: Audio: aac (LC), 44100 Hz, mono, fltp (default)";
        assert_eq!(audio_codec(text).as_deref(), Some("aac"));
    }

    #[test]
    fn a_silent_file_has_no_audio_codec_and_no_audio_streams() {
        // REAL: h264 mp4 made with -an.
        let text = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'silent.mp4':\n  Duration: 00:00:01.00, start: 0.000000, bitrate: 31 kb/s\n    Stream #0:0(und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p, 160x90 [SAR 1:1 DAR 16:9], 28 kb/s, 10 fps, 10 tbr, 10240 tbn, 20 tbc (default)\n    Metadata:\n      handler_name    : VideoHandler";
        assert_eq!(audio_codec(text), None);
        assert_eq!(audio_stream_count(text), 0);
        let probe = media(text);
        assert_eq!((probe.audio_streams, probe.audio_codec), (0, None));
    }

    #[test]
    fn agreeing_audio_streams_are_fine() {
        // REAL: an mp4 with two aac tracks.
        let text = "    Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)\n    Stream #0:2(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 70 kb/s";
        assert_eq!(audio_codec(text).as_deref(), Some("aac"));
        assert_eq!(audio_stream_count(text), 2);
    }

    #[test]
    fn disagreeing_audio_streams_are_not_trusted_but_are_counted() {
        // REAL: an mp4 with an aac track then an mp3 track. Both are playable,
        // but the probe does not choose between streams. The count is what
        // tells the caller this is doubt and not silence.
        let text = "    Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)\n    Stream #0:2(und): Audio: mp3 (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 65 kb/s";
        assert_eq!(audio_codec(text), None);
        assert_eq!(audio_stream_count(text), 2);
        // SYNTHETIC: the case this exists for, an unplayable stream behind a playable one.
        let bad = "    Stream #0:1: Audio: aac (LC), 44100 Hz, mono\n    Stream #0:2: Audio: amr_nb (samr / 0x726D6173), 8000 Hz, mono";
        assert_eq!(audio_codec(bad), None);
        assert_eq!(audio_stream_count(bad), 2);
    }

    #[test]
    fn an_audio_line_of_an_unknown_shape_is_doubt_not_absence() {
        // SYNTHETIC. A stream line whose id holds a space, or with no codec
        // after the marker: skipping either would let an unreadable stream pass
        // unseen beside a readable aac one.
        let odd_id = "    Stream #0:1: Audio: aac (LC), 44100 Hz\n    Stream #0:2 odd id: Audio: amr_nb, 8000 Hz";
        assert_eq!(audio_codec(odd_id), None);
        assert_eq!(audio_stream_count(odd_id), 2);
        assert_eq!(audio_codec("    Stream #0:1: Audio: "), None);
        assert_eq!(audio_stream_count("    Stream #0:1: Audio: "), 1);
    }

    #[test]
    fn metadata_that_mentions_audio_is_not_a_stream() {
        // SYNTHETIC. Skipped at the `Stream #` prefix, so neither read nor counted.
        let text = "    Metadata:\n      comment         : Stream #9: Audio: amr_nb fake\n    Stream #0:0: Video: h264 (High), yuv420p";
        assert_eq!(audio_codec(text), None);
        assert_eq!(audio_stream_count(text), 0);
    }

    #[test]
    fn an_unopenable_file_has_no_audio() {
        // REAL: 5000 random bytes named .mp4. The caller converts anyway,
        // because codec and container are None too.
        assert_eq!(audio_codec("junk.mp4: Invalid data found when processing input"), None);
        assert_eq!(audio_stream_count("junk.mp4: Invalid data found when processing input"), 0);
        // SYNTHETIC: no output at all.
        assert_eq!(audio_stream_count(""), 0);
    }

    #[test]
    fn the_probe_crosses_the_bridge_in_camel_case() {
        // SYNTHETIC. The webview reads `audioCodec` and `audioStreams`. A
        // snake_case key would arrive as `undefined`, which must not be able to
        // read as "silent".
        let text = "    Stream #0:0: Video: h264 (High), yuv420p, 160x90\n    Stream #0:1: Audio: amr_nb (samr / 0x726D6173), 8000 Hz";
        let json = serde_json::to_value(media(text)).unwrap();
        assert_eq!(json["audioCodec"], "amr_nb");
        assert_eq!(json["audioStreams"], 1);
        assert!(json.get("audio_codec").is_none());
    }
}
