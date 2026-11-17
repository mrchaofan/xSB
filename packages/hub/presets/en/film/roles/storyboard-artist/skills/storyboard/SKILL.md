---
description: Draw a storyboard frame for every shot in the shot list
produces: storyboard
inputs: shot_list, style_guide, character
---
# Storyboard frames

Do this only after the director has approved the shot list. One still per shot, showing **the first frame of that shot**. It serves three purposes: the director sees the composition before any video is generated; the editor lays the frames out as an animatic to check the pacing; the cinematographer uses it as the first frame to generate the video.

Register one master table as `storyboard/<title-or-scene>` (markdown), and each frame as `frame/<shot>`.

## Generating the images

Use the image tool chosen for this film, once per shot:

- Reference images: the look references of the characters in the shot (from the character sheet in `character`), plus the scene reference image for the scene (from `style_guide`). In the prompt, refer to them in order (how they are named follows the image tool's description; the example below calls them 图一, 图二), and say clearly what to borrow from each.
- Prompt order: the character's appearance description (copied **verbatim** from `character`) → the character's position and pose in this frame → setting → shot size and camera position → lighting → style suffix (copied **verbatim** from `style_guide`).
- Use the aspect ratio from the brief, the same for the whole film. The video will follow this image's aspect ratio.
- Describe the frame at **the moment the action starts**, not how it looks once the action is done. The first frame of "walks from the left to the window" has the character at the left of the frame.

Example:

> The person in 图一, keeping the face, hair, and costume exactly the same: A thirty-year-old woman with shoulder-length black hair and a lean face, wearing a long dark gray trench coat over a white shirt, carrying a faded dark green canvas bag. She stands at the left edge of the frame, dragging a suitcase, her body turned toward the ticket booth at the right of the frame. Scene reference 图二: A ferry landing late at night, fog over the river, a single dim yellow light on in the ticket booth. Medium shot, eye level. The only light source is the ticket booth. Realistic cinematic look, low-key lighting, warm tungsten light with teal shadows, shallow depth of field, film grain, restrained color, no text in frame. 16:9 horizontal composition.

## What to draw for each generation method

| Shot list says | What to draw |
| - | - |
| First frame | The first frame, registered as `frame/<shot>` |
| First and last frames | The first frame and the last frame, the latter registered as `frame/<shot>-end`; when generating the last frame, pass the first frame as a reference image too, so both show the same space |
| Continue from last frame | Still draw one, used only for review and the animatic; the video will use the last frame of the previous shot |
| Reference images, text-to-video | Draw one representative frame, used only for review and the animatic |

## Checks (every frame)

- Compare the character side by side with the look reference: do the face, hair, and costume match?
- Do the shot size and camera position match the shot list?
- Put it next to the previous shot's frame: do the 180-degree line, eyeline direction, and light direction match?
- Are the hands or face distorted? Is there any stray text or extra object?

If it fails, revise the prompt and regenerate, changing only one thing at a time.

## Master table

| Shot | Frame asset | Duration (s) | Content in one sentence | Notes |
| - | - | - | - | - |

Copy the durations from the shot list; the editor lays out the animatic by them. If you find a problem with the shot design while drawing (the composition cannot be achieved, two shots are really one), raise it in the result and let the director decide whether to change the shot list; do not change it yourself.
