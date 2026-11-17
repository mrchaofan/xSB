---
description: 把分镜画面按时长排成动态分镜，供导演看节奏
produces: animatic
inputs: shot_list, storyboard
---
# 动态分镜

把每个镜头的分镜画面按镜头表的时长排成一段视频。它不好看，也不需要好看：它的用处是在花钱生成视频之前，让导演看到全片的节奏。

登记为 `animatic/<片名>`（mp4）。

## 步骤

1. 读 `storyboard` 的总表，用 `get_asset` 取得每张 `frame/<镜号>` 的文件路径；时长以 `shot_list` 为准。
2. 每张画面做成一段静止的视频，左上角烧上镜号，方便导演指着说：

```
ffmpeg -loop 1 -t 5 -i frames/3-1.png -f lavfi -t 5 -i anullsrc=r=48000:cl=stereo -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1,fps=24,drawtext=text='3-1':x=24:y=24:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.5" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest tmp/3-1.mp4
```

   `drawtext` 在这台机器的 ffmpeg 上不可用时去掉它，在结果里按顺序列出每个镜号的起止时间。

3. 按镜头表的顺序拼接（`list.txt` 每行 `file 'tmp/3-1.mp4'`）：

```
ffmpeg -f concat -safe 0 -i list.txt -c copy animatic/film.mp4
```

4. 自己检查一遍（总时长、每个镜号都在、没有黑帧），再用 `put_asset` 登记。

分辨率用 720p 就够。镜头表里的时长含剪辑余量；这里按成片里预计用的时长排（一般每镜减 1–2 秒），并在结果里说明用的是哪个。

## 结果里要写

- 总时长，与简报相差多少。
- 你看下来的节奏问题：哪里拖、哪里跳、哪两个镜头接不上、哪个镜头可以删。这是你作为剪辑师的意见，改不改由导演定。
- 缺画面的镜号。
