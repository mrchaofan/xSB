---
description: Generate character, scene, and style reference images with the image model
---
# Generating reference images

Use the image tool chosen for this film. The model and its limits are given in the tool description, which takes precedence.

## Prompts

Write in coherent natural language; do not pile up keywords. Order: **subject + action or pose + setting**, then add **style, color, lighting, composition**. Use concise, precise descriptions and avoid repetitive modifiers.

How to write a character reference image (put the appearance description from the character sheet verbatim at the start):

> A thirty-year-old woman with shoulder-length black hair and a lean face, wearing a long dark gray trench coat over a white shirt, carrying a faded dark green canvas bag. Front-facing, waist-up portrait, standing naturally, looking straight into the camera, with a calm expression. Plain light gray background, even and soft frontal light, no shadows. Realistic photography, 85mm portrait lens. Vertical composition.

- **Keep the background clean and the light flat.** A reference image is for the video model to recognize the person; dramatic lighting gets learned along with the face.
- **State the aspect ratio in the prompt** ("vertical composition", "16:9 horizontal composition"), or give exact pixels with `size`.
- When the image needs text, put the exact words in quotation marks; when it does not, write "no text in frame".

## Staying consistent with reference images

Pass existing images as reference images and refer to them in the prompt in order (how they are named follows the image tool's description; the example below calls them 图一, 图二), saying what to borrow from each:

> The person in 图一, keeping the face, hair, and costume exactly the same. Full body, standing side-on, facing the right of the frame. Plain light gray background, even soft light.

Editing an image works the same way: say what to keep first, then what to change ("keep the person and pose in 图一 unchanged, and change the trench coat to beige").

Map identity, costume, props, setting and pose to the individual reference images. Borrowing a prop or pose from another person's image can also import that face; prefer an isolated prop reference or a permitted crop. When multiple photos of the subject are required, actually pass them; report capability limits rather than silently dropping inputs, and do not count copies of one photo as independent references.

For revisions, pin the user-selected baseline asset and version and state what stays and what changes. Record approval status separately from reference use: an older candidate can remain a valid reference. Do not revoke a verified source or existing permission just because it belongs to an earlier round; explain any actual tool restriction with evidence.

## Checking

Compare each image with its baseline: identity, costume, props, subject count and composition should remain intact, and the requested change must actually appear. Check faces, hands and text, and measure dimensions and aspect ratio. Cropping must preserve needed heads, hands and props; do not stretch. Calibrate subjective performance against the user's selected images. Revise for a specific issue each round; repeated failures call for reporting the unmet requirement and proposing reference or design changes within the authorised retry scope.

## Registering

`put_asset`, with `path` pointing to the image file and the prompt in `description`.
