---
description: 把镜头剪成成片并导出
produces: cut
inputs: shot_list, shot
---
# 剪辑

## 步骤

1. 读 `shot_list`，用 `find_assets` 列出全部 `shot`，核对每个镜号都有通过的正式版。用 `get_asset` 取得文件路径。
2. 检查素材：`ffprobe -v error -show_streams <文件>`，记下每个文件的分辨率、帧率、编码、有无音轨。
3. 定每个镜头的入点和出点：去掉开头的起势和结尾多余的部分，动作镜头切在动作中。
4. 统一参数并裁剪（见下），再拼接，导出到 `cut/<片名>.mp4`。
5. 检查成片：总时长、有没有黑帧或跳帧、音画是否同步、首尾是否干净。
6. 用 `put_asset` 登记 `cut/<片名>`，并登记剪辑表 `edl/<片名>`。之后每一轮修改都登记为同一个 id 的新版本，描述里写明这是哪一轮（粗剪 / 导演版 / 锁定版）和改了什么。

## 命令

逐个片段裁剪并统一参数（分辨率、帧率按简报）：

```
ffmpeg -ss 0.5 -to 4.5 -i shots/s01_01.mp4 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,fps=24" -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 tmp/s01_01.mp4
```

没有音轨的片段补一条静音，否则拼接后音画会错位：

```
ffmpeg -i tmp/s01_02.mp4 -f lavfi -i anullsrc=r=48000:cl=stereo -shortest -c:v copy -c:a aac tmp/s01_02a.mp4
```

拼接（`list.txt` 每行 `file 'tmp/s01_01.mp4'`）：

```
ffmpeg -f concat -safe 0 -i list.txt -c copy cut/film.mp4
```

## 声音

- 对白镜头保留原声。
- 相邻镜头的环境声不连贯时，在剪辑点做 0.1–0.3 秒的音频淡入淡出（`afade`），或把同一场里某一镜的环境声铺满整场、其他镜头的环境声压低。
- 镜头里出现了不该有的音乐，去掉该镜头的音轨并报告，由导演决定是否重拍。
- 粗剪和导演版只做到声音不跳变即可。导演告知画面已锁定后，再做声音精修并导出最终版。
- 这支剧组不生成配乐和旁白。用户提供了音频文件时（导演会在任务里给出路径或资产 id），在锁定画面后混入：

```
ffmpeg -i cut/film.mp4 -i music.mp3 -filter_complex "[1:a]volume=0.25,afade=t=out:st=55:d=5[m];[0:a][m]amix=inputs=2:duration=first[a]" -map 0:v -map "[a]" -c:v copy -c:a aac cut/film_final.mp4
```

- 简报要求配乐或旁白而没有收到文件时，在结果里说明。

## 剪辑表

| 序 | 镜号 | 素材资产 | 入点 | 出点 | 时长 | 转场 | 声音处理 | 备注 |
| - | - | - | - | - | - | - | - | - |

默认硬切。只有在表示时间流逝或场景转换时才用叠化。

## 节奏自查

- 开头三秒能不能让人明白在看什么。
- 有没有哪个镜头停留得比它的信息量更久。
- 相邻镜头的运动方向、人物位置、视线接得上吗。
- 结尾是否停在一个画面上，而不是戛然而止。
- 总时长与简报的差距在 5% 以内。

## 结果里要写

成片资产 id、总时长、分辨率与帧率；缺失或不合格的镜头清单；声音上做了什么处理；你认为需要补拍或重拍的地方。
