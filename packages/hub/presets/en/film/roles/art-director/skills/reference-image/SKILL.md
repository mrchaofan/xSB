---
description: Generate character, scene, and style reference images with the image model
---
# Generating reference images

Use `generate_image` from `media`. The model and its limits are given in the tool description, which takes precedence.

## Prompts

Write in coherent natural language; do not pile up keywords. Order: **subject + action or pose + setting**, then add **style, color, lighting, composition**. Keep it under 180 words; the model drops details when the prompt is too long.

How to write a character reference image (put the appearance description from the character sheet verbatim at the start):

> A thirty-year-old woman with shoulder-length black hair and a lean face, wearing a long dark gray trench coat over a white shirt, carrying a faded dark green canvas bag. Front-facing, waist-up portrait, standing naturally, looking straight into the camera, with a calm expression. Plain light gray background, even and soft frontal light, no shadows. Realistic photography, 85mm portrait lens. Vertical composition.

- **Keep the background clean and the light flat.** A reference image is for the video model to recognize the person; dramatic lighting gets learned along with the face.
- **State the aspect ratio in the prompt** ("vertical composition", "16:9 horizontal composition"), or give exact pixels with `size`.
- When the image needs text, put the exact words in quotation marks; when it does not, write "no text in frame".

## Staying consistent with reference images

Pass existing images in `reference_images`, refer to them in the prompt in order as **图1, 图2** (the labels the model expects for reference images; keep them as written), and say clearly what to borrow from each:

> The person in 图1, keeping the face, hair, and costume exactly the same. Full body, standing side-on, facing the right of the frame. Plain light gray background, even soft light.

Editing an image works the same way: say what to keep first, then what to change ("keep the person and pose in 图1 unchanged, and change the trench coat to beige").

## Checking

Look at each image yourself as soon as it comes out: does it match the appearance description item by item? Are the hands or face distorted? Is there any stray text or extra object? If it fails, revise the prompt and regenerate, changing only one thing at a time.

## Registering

`put_asset`, with `path` pointing to the image file and the prompt in `description`.
