---
description: Generate and register the shots for a scene
produces: shot
inputs: shot_list, storyboard, style_guide, character
---
# Generating shots

## Workflow

1. Read the inputs: `shot_list`, `storyboard`, `style_guide`, and the `character` of everyone in the scene. Copy down the style suffix, the location suffix of this scene, each character's appearance description, and the user's hard requirements from the style guide (check against them before generating); use `get_asset` to get the file paths of the storyboard frames and reference images you need.
2. Order by dependency: shots with no "continue from last frame" dependency can be submitted together, but submit one or two first and the rest once those come out right. The reason: a generation that has started cannot be called back, and the more you submit at once, the more is wasted when the director calls a halt.
3. Write a prompt for each shot (see below) and submit it with `start_job` to the video tool chosen for this film (`server` and `tool` are its server and tool names), at draft resolution.
4. `await_tasks`, then end your turn: the task stays open, and you carry on when the results come back. Check the files then, and adjust and reshoot any that fail (submit again, `await_tasks` again).
5. Use `put_asset` to register each draft as `shot/<shot>` (with `path` pointing to the video file), with the prompt and parameters in the description, marked as a draft. Hand them to the director for review with `complete_task`, naming them in `assets`; this task ends here.
6. Once the user has signed off, the director sends a new task for the finals: generate them with **exactly the same prompt and inputs** at the final resolution, and register each as a new version of the same `shot/<shot>`, marked as final.

## Prompts

Write one coherent paragraph; do not pile up keywords. The order is fixed:

1. **Subject**: the character's appearance description (copied verbatim). If you use reference images, state which image is which (see below).
2. **Action**: one clear action, with its start, end, and speed ("walks slowly from the left of the frame to the window, stops, and looks up").
3. **Setting**: location, time, and what is visible in the surroundings.
4. **Camera**: shot size, angle, movement ("medium shot, eye level, camera slowly pushes in").
5. **Lighting**: where the light comes from and its quality.
6. **Sound** (shots with sound): who says what, in quotation marks; what the ambient sound is.
7. **Location suffix and style suffix** (both copied verbatim, the location suffix first).

Example (reference images are numbered in the order they are passed; how the prompt names them follows the video tool's description):

> A thirty-year-old woman with shoulder-length black hair and a lean face, wearing a long dark gray trench coat over a white shirt, carrying a faded dark green canvas bag (see reference image 1). Dragging a suitcase, she jogs from the left of the frame to the ticket booth window, stops, and raises a hand to knock twice on the glass. A ferry landing late at night, fog over the river, a single dim yellow light on in the ticket booth (scene reference: 图片2). Medium shot, eye level, static camera. The only light source is the ticket booth, casting warm light on the side of her face. She says: "Is there still a boat tonight?" The ambient sound is water in the distance. Realistic cinematic look, low-key lighting, warm tungsten light with teal shadows, shallow depth of field, film grain, slow and steady camera movement, restrained color, no text in frame.

Key points:

- **Write only what is in the frame.** The model is poor at understanding "no ..."; to exclude text, write "no text in frame".
- **One action and one camera movement per shot.**
- **Use specific words**: not "a beautiful night scene" but "a river in fog, a row of blurred orange lights on the far bank".
- **Dialogue**: put the exact words in quotation marks and state who speaks; one person, one line per shot. For a silent shot, set `audio` to false and do not write any lines.
- **Text in the frame**: when it is needed, put the exact words in quotation marks and say where they appear.
- When something must change within a shot, prefer having the storyboard artist split it into two shots. When it has to be one prompt, write it the way the tool's description says this model follows: some versions follow only numbered shots ("shot 1 ..., shot 2 ..."), others whole-second time ranges ("0–3 s ..., 3–6 s ...").

## Writing about reference images

Reference images are numbered in the order they are passed; how the prompt names them follows the video tool's description. In the prompt, **say for each image what to borrow from it**: the person, the costume, the setting, or the composition. If you pass an image without explanation, the model does not know how to use it.

## Parameters for the five generation methods

The parameter names are the video tool's; below are the usual ones.

| Shot list says | Parameters |
| - | - |
| First frame | `first_frame`: this shot's storyboard frame, `frame/<shot>`. Start the prompt from what happens after this frame; there is no need to describe the composition already in the image |
| Text-to-video | `prompt` only |
| Reference images | `reference_images`: character reference images first, scene reference images after |
| Continue from last frame | Submit the previous shot with `last_frame_output: "shots/<previous-shot>_last.jpg"` (the last frame is a JPEG); use that file as this shot's `first_frame`. The previous shot's result says whether its last frame was saved; when it was not, do not use the file |
| First and last frames | `first_frame` and `last_frame`: `frame/<shot>` and `frame/<shot>-end`, as registered by the storyboard artist |

Limits: which parameters cannot be combined, how many reference images a call may carry, how large images may be, and whether images with faces are accepted all depend on the model; they are in the video tool's description and the chosen model's skill, which take precedence. Use only the reference images the shot needs: one front view per character plus one scene image, usually two or three in all.

## Other parameters

| Parameter | Usage |
| - | - |
| `output` | `shots/<shot>.mp4`, for example `shots/s03_02.mp4`; add `_draft` for drafts |
| `duration` | The duration in the shot list (which already includes editing margin), not exceeding the limit in the tool description |
| `ratio` | The same for the whole film, following the aspect ratio in the brief |
| `resolution` | The model's lowest resolution for drafts (e.g. `480p`); for finals, follow the delivery specs in the brief |
| `audio` | true for shots with dialogue or that need production sound; false for picture-only shots (the editor handles the sound) |

## Self-check (every shot, before delivery)

The character matches the look references; the composition matches the storyboard frame; the action completes, with spare footage at the head and tail; no obvious artifacts in limbs or faces; no garbled text; the color grade cuts smoothly with adjacent shots; for shots with sound, the dialogue is correct.

When reshooting, **change only one thing at a time**, or you will not know which change made the difference. Before submitting a reshoot, compare the old and new prompt and parameters and make sure the one change is really there: when a script or file name was not updated along with it, the reshoot comes out the same and costs all the same. If the same shot still fails after three attempts, stop, describe the symptoms in the result, and suggest how to change the shot design.

## Technical check

The technical check the director sends once the brief is signed off: one low-resolution draft with a face and one spoken line. In the result, say whether the first frame with the face was accepted and which image it was; whether lip sync and voice are usable; whether anything needs the user's own approval or activation; and what this one draft really cost (the usage and the estimated amount).

## Test shoot

When the director dispatches only two or three shots and says it is a test shoot: produce drafts only, no finals. In the result, besides the shots themselves, state how many generations each shot took to get a usable version, and why each failed attempt failed. The director uses this to estimate the cost of the whole film.

## What to include in the result

For each shot: shot number, asset id, duration, whether it is a draft or a final, and how many times it was generated in total; for reshot shots, the reason and what was changed; for unfinished shots, where they are stuck; any canceled tasks and whether they were billed. Close with the total usage and estimated cost of the task, as the generation tool reported them; what it did not report is "unknown": do not guess, and do not write "free".
