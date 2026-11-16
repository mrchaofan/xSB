---
description: Lay out the storyboard frames by duration as an animatic, for the director to check pacing
produces: animatic
inputs: shot_list, storyboard
---
# Animatic

Lay out each shot's storyboard frame for the duration given in the shot list, as one video. It is not pretty and does not need to be: its purpose is to show the director the pacing of the whole film before any money is spent on generating video.

Register as `animatic/<title>` (mp4).

## Steps

1. Read the master table in `storyboard`, and use `get_asset` to get the file path of each `frame/<shot>`; durations follow `shot_list`.
2. Turn each frame into a still video clip, with the shot number burned into the top-left corner so the director can point to it:

```
ffmpeg -loop 1 -t 5 -i frames/3-1.png -f lavfi -t 5 -i anullsrc=r=48000:cl=stereo -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1,fps=24,drawtext=text='3-1':x=24:y=24:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.5" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest tmp/3-1.mp4
```

   If `drawtext` is not available in this machine's ffmpeg, drop it and list each shot number's start and end times, in order, in the result.

3. Concatenate in shot-list order (each line of `list.txt` is `file 'tmp/3-1.mp4'`):

```
ffmpeg -f concat -safe 0 -i list.txt -c copy animatic/film.mp4
```

4. Watch it yourself from start to finish, then register it with `put_asset`.

720p is enough. Durations in the shot list include editing margin; here, lay the frames out for the duration you expect to use in the finished film (usually 1–2 seconds less per shot), and state in the result which one you used.

## What to include in the result

- The total running time, and how far it is from the brief.
- The pacing problems you saw: where it drags, where it jumps, which two shots do not cut together, which shot could be removed. This is your opinion as the editor; whether to change anything is the director's call.
- The shot numbers with missing frames.
