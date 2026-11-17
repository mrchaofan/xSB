---
description: Break a scene or the whole film into a shot list
produces: shot_list
inputs: script, style_guide, character
---
# Shot list

Register as `shot_list/<title-or-scene>`, as a markdown table.

## Columns

| Shot | Duration (s) | Shot size | Camera position and angle | Movement | Content | Sound and dialogue | Generation method | Notes |
| - | - | - | - | - | - | - | - | - |

- **Shot**: `scene-sequence`, for example `3-2`.
- **Shot size**: extreme wide shot / wide shot / full shot / medium shot / medium close-up / close-up / extreme close-up.
- **Camera position and angle**: eye level, high angle, low angle; frontal, profile, over the shoulder; camera height.
- **Movement**: static / push in / pull out / pan / track / follow / crane / orbit, plus the speed. When in doubt, use static or a slow push-in.
- **Content**: who, doing what, where. One sentence, one action, stating where the action starts and ends ("walks from the left of the frame to the window and stops").
- **Sound and dialogue**: who says what (the exact words), and the ambient sound. For a silent shot, write "none".
- **Generation method**: one of the five below.
- **Notes**: how the shot connects to its neighbors, and any consistency points that need special care.

## The five generation methods

Once the shot list is approved, you draw a storyboard frame for every shot (skill `storyboard`). The generation method determines how that frame is used.

| Method | When to use | How to write it |
| - | - | - |
| First frame | Most shots that include a main character: the storyboard frame is the shot's first frame | `first frame` |
| First and last frames | Shots that need a precise end point (walking to a spot, turning to an angle): draw a last frame as well | `first and last frames` |
| Continue from last frame | The shot directly follows the previous one in the same scene and must carry over position and lighting exactly | `continue from 3-1 last frame` |
| Reference images | The character enters from off-screen, or the action starts with large movement, so a first frame cannot be pinned down | `reference images: reference/aning-front, reference/scene-ferry` |
| Text-to-video | Empty shots, environments, no main characters | `text-to-video` |

Constraints: many video models **do not take reference images together with a first frame (first frame, continue from last frame, first and last frames)**, and with a first frame the aspect ratio follows the first-frame image; the chosen model's description says how it is. A "continue from last frame" shot depends on the previous shot and cannot be generated in parallel; do not build a whole scene out of them.

## Design rules

1. **Set the rhythm of the scene first**: where its turning point is; at the turn, the shots get denser or closer.
2. **Progress through shot sizes**: establish the setting (wide) → show the relationships (medium) → emphasize emotion (close). Never put two shots with the same shot size and the same angle back to back.
3. **The 180-degree line**: when two people talk, the camera always stays on the same side of the line between them.
4. **Break down action**: split a complex action into "start, process, result", one shot each.
5. **Dialogue**: only one person speaks per shot, and a line is about six words. Put the speaker in a medium close-up or medium shot, with the face clearly visible.
6. **Steer around the model's weaknesses**: several people doing different things at once, fine hand work, text in the frame, fast physical contact. Where they cannot be avoided, use a wider shot or cut around them.

## At the end of the table

The total number of shots, the total duration (matching the brief), every reference image asset used, which shots can be generated in parallel, and which have ordering dependencies. Also flag the two or three shots you consider hardest to generate; the director will use them for the test shoot.

## Self-check before delivery

- Take each shot on its own: can the cinematographer tell what to generate without reading the script?
- For every shot with a main character, is it clear what keeps it consistent?
- Read the "Content" column straight through: is the story clear?
