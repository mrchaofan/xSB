---
description: Cut the shots into the finished film and export it
produces: cut
inputs: shot_list, shot
---
# Editing

## Steps

1. Read `shot_list`, list all `shot` assets with `find_assets`, and verify that every shot number has an approved final. Use `get_asset` to get the file paths.
2. Check the footage: `ffprobe -v error -show_streams <file>`, and note each file's resolution, frame rate, codec, and whether it has an audio track.
3. Set each shot's in and out points: trim the wind-up at the head and the excess at the tail, and cut action shots on the action.
4. Normalize the parameters and trim (see below), then concatenate and export to `cut/<title>.mp4`.
5. Check the finished film: total running time, any black or dropped frames, whether audio and picture are in sync, whether the head and tail are clean.
6. Use `put_asset` to register `cut/<title>`, and register the edit decision list as `edl/<title>`. After that, register every round of revisions as a new version of the same id, stating in the description which round it is (rough cut / director's cut / locked version) and what changed.

## Commands

Trim each clip and normalize its parameters (resolution and frame rate from the brief):

```
ffmpeg -ss 0.5 -to 4.5 -i shots/s01_01.mp4 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,fps=24" -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 tmp/s01_01.mp4
```

Add a silent track to any clip without audio; otherwise audio and picture drift out of sync after concatenation:

```
ffmpeg -i tmp/s01_02.mp4 -f lavfi -i anullsrc=r=48000:cl=stereo -shortest -c:v copy -c:a aac tmp/s01_02a.mp4
```

Concatenate (each line of `list.txt` is `file 'tmp/s01_01.mp4'`):

```
ffmpeg -f concat -safe 0 -i list.txt -c copy cut/film.mp4
```

## Sound

- Keep the original sound on dialogue shots.
- When the ambient sound of adjacent shots does not match, apply a 0.1–0.3 second audio fade in and out at the cut (`afade`), or lay the ambient sound of one shot under the whole scene and turn down the ambient sound of the other shots.
- If a shot contains music that should not be there, remove that shot's audio track and report it; the director decides whether to reshoot.
- For the rough cut and the director's cut, it is enough that the sound does not jump. Once the director tells you the picture is locked, polish the sound and export the final version.
- This crew does not generate music or narration. When the user has supplied audio files (the director gives the path or asset id in the task), mix them in after picture lock:

```
ffmpeg -i cut/film.mp4 -i music.mp3 -filter_complex "[1:a]volume=0.25,afade=t=out:st=55:d=5[m];[0:a][m]amix=inputs=2:duration=first[a]" -map 0:v -map "[a]" -c:v copy -c:a aac cut/film_final.mp4
```

- If the brief calls for music or narration and no file was received, say so in the result.

## Edit decision list

| No. | Shot | Source asset | In | Out | Duration | Transition | Sound treatment | Notes |
| - | - | - | - | - | - | - | - | - |

Hard cuts by default. Use a dissolve only to mark the passage of time or a change of scene.

## Pacing self-check

- Do the first three seconds make clear what we are watching?
- Is any shot held longer than the information it carries warrants?
- Do the directions of movement, character positions, and eyelines of adjacent shots match?
- Does the ending rest on an image rather than stopping abruptly?
- Is the total running time within 5% of the brief?

## What to include in the result

The finished film's asset id, total running time, resolution, and frame rate; the list of missing or substandard shots; what sound treatment you applied; where you think pickups or reshoots are needed.
