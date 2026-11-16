---
description: Generate and register the shots for a scene
produces: shot
inputs: shot_list, storyboard, style_guide, character
---
# Generating shots

## Workflow

1. Read the inputs: `shot_list`, `storyboard`, `style_guide`, and the `character` of everyone in the scene. Copy down the style suffix and each character's appearance description; use `get_asset` to get the file paths of the storyboard frames and reference images you need.
2. Order by dependency: shots with no "continue from last frame" dependency can be submitted together.
3. Write a prompt for each shot (see below) and submit it with `start_job`: `server: "media"`, `tool: "generate_video"`, at draft resolution.
4. `await_tasks`. When the results come back, check the files, then adjust and reshoot any that fail.
5. Hand the drafts to the director for review. For approved shots, produce the final resolution with **exactly the same prompt and inputs**.
6. Use `put_asset` to register each as `shot/<shot>` (with `path` pointing to the video file), with the prompt and parameters in the description.

## Prompts

Write one coherent paragraph; do not pile up keywords. The order is fixed:

1. **Subject**: the character's appearance description (copied verbatim). If you use reference images, state which image is which (see below).
2. **Action**: one clear action, with its start, end, and speed ("walks slowly from the left of the frame to the window, stops, and looks up").
3. **Setting**: location, time, and what is visible in the surroundings.
4. **Camera**: shot size, angle, movement ("medium shot, eye level, camera slowly pushes in").
5. **Lighting**: where the light comes from and its quality.
6. **Sound** (shots with sound): who says what, in quotation marks; what the ambient sound is.
7. **Style suffix** (copied verbatim).

Example (【图片1】, 【图片2】 are the labels the video model expects for reference images; keep them as written):

> A thirty-year-old woman with shoulder-length black hair and a lean face, wearing a long dark gray trench coat over a white shirt, carrying a faded dark green canvas bag (see 【图片1】). Dragging a suitcase, she jogs from the left of the frame to the ticket booth window, stops, and raises a hand to knock twice on the glass. A ferry landing late at night, fog over the river, a single dim yellow light on in the ticket booth (scene reference: 【图片2】). Medium shot, eye level, static camera. The only light source is the ticket booth, casting warm light on the side of her face. She says: "Is there still a boat tonight?" The ambient sound is water in the distance. Realistic cinematic look, low-key lighting, warm tungsten light with teal shadows, shallow depth of field, film grain, slow and steady camera movement, restrained color, no text in frame.

Key points:

- **Write only what is in the frame.** The model is poor at understanding "no ..."; to exclude text, write "no text in frame".
- **One action and one camera movement per shot.**
- **Use specific words**: not "a beautiful night scene" but "a river in fog, a row of blurred orange lights on the far bank".
- **Dialogue**: put the exact words in quotation marks and state who speaks; one person, one line per shot. For a silent shot, set `audio` to false and do not write any lines.
- **Text in the frame**: when it is needed, put the exact words in quotation marks and say where they appear.
- When something must change within a shot, write it by time range ("0–3 s ..., 3–6 s ..."); but prefer having the storyboard artist split it into two shots.

## Writing about reference images

The images in `reference_images` are, in order, 【图片1】, 【图片2】, and so on. In the prompt, **say for each image what to borrow from it**: the person, the costume, the setting, or the composition. If you pass an image without explanation, the model does not know how to use it.

## Parameters for the five generation methods

| Shot list says | Parameters |
| - | - |
| First frame | `first_frame`: this shot's storyboard frame, `frame/<shot>`. Start the prompt from what happens after this frame; there is no need to describe the composition already in the image |
| Text-to-video | `prompt` only |
| Reference images | `reference_images`: character reference images first, scene reference images after |
| Continue from last frame | Submit the previous shot with `last_frame_output: "shots/<previous-shot>_last.jpg"` (the last frame is a JPEG); use that file as this shot's `first_frame` |
| First and last frames | `first_frame` and `last_frame`: `frame/<shot>` and `frame/<shot>-end`, as registered by the storyboard artist |

Limits:

- `reference_images` and `first_frame` cannot be used together. When using `first_frame`, do not pass `ratio`; the aspect ratio follows the first-frame image.
- How many reference images a call may carry depends on the model version; the number is in the tool description of `generate_video`. Use only what the shot needs: one front view per character plus one scene image, usually two or three in all.
- Images are sent inside the request, and all the images of one call together must stay under a size limit (also in the tool description). When a look reference is a very large PNG, make a JPEG copy first with `ffmpeg -i original.png -q:v 2 copy.jpg` and pass that; the copy is for generating only and is not registered as an asset.

## Other parameters

| Parameter | Usage |
| - | - |
| `output` | `shots/<shot>.mp4`, for example `shots/s03_02.mp4`; add `_draft` for drafts |
| `duration` | The duration in the shot list (which already includes editing margin), not exceeding the limit in the tool description |
| `ratio` | The same for the whole film, following the aspect ratio in the brief |
| `resolution` | `480p` for drafts; for finals, follow the delivery specs in the brief |
| `audio` | true for shots with dialogue or that need production sound; false for picture-only shots (the editor handles the sound) |

## Self-check (every shot, before delivery)

The character matches the look references; the composition matches the storyboard frame; the action completes, with spare footage at the head and tail; no obvious artifacts in limbs or faces; no garbled text; the color grade cuts smoothly with adjacent shots; for shots with sound, the dialogue is correct.

When reshooting, **change only one thing at a time**, or you will not know which change made the difference. If the same shot still fails after three attempts, stop, describe the symptoms in the result, and suggest how to change the shot design.

## Test shoot

When the director dispatches only two or three shots and says it is a test shoot: produce drafts only, no finals. In the result, besides the shots themselves, state how many generations each shot took to get a usable version, and why each failed attempt failed. The director uses this to estimate the cost of the whole film.

## What to include in the result

For each shot: shot number, asset id, duration, whether it is a draft or a final, and how many times it was generated in total; for reshot shots, the reason and what was changed; for unfinished shots, where they are stuck; any canceled tasks and whether they were billed.
