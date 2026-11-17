---
description: Create the character sheet and look references for one character
produces: character
inputs: brief, script, casting
---
# Character sheet

One per character, registered as `character/<character>`, with the name matching the script.

A main character's face was already chosen by the user during casting: the task states which candidate to use (`candidate/<character>-<n>`). **That image is this person.** Every later image uses it as a reference; do not redesign the face. For a supporting character who did not go through casting, start from the front-facing waist-up shot in section 4.

## 1. Basics
Age, role, and function in the story (one sentence).

## 2. Appearance
- **Face and hair**: write from the chosen candidate. Face shape, skin tone, hairstyle and hair color, and the one or two most stable features.
- **Build and posture**: height and build, how they stand and walk.
- **Costume**: for each outfit, its cut, color, and material, and which scenes it appears in. Choose colors that stand out from the settings.
- **Signature item**: one thing they carry that helps identify them.

Avoid designs that tend to generate badly: complex patterns, text graphics, fine jewelry, mirror-like reflective materials.

## 3. Appearance description (required)
**One fixed passage of 20–35 words**, used verbatim in every shot the character appears in. Write only visible features, in a fixed order: age and gender → face and hair → costume → signature item.

> A thirty-year-old woman with shoulder-length black hair and a lean face, wearing a long dark gray trench coat over a white shirt, carrying a faded dark green canvas bag.

For a costume change, add another passage and note which scenes it applies to.

## 4. Look references (required)

A look test puts the chosen face into the character's look in the film. Generate the images as described in the skill `reference-image`; for every image, pass the chosen candidate as a reference image and state "keep the face of 图一 exactly the same" (图一, 图二 are the labels the image model expects for reference images; keep them as written). Register each image as `reference/<character>-<view>`:

| Image | Purpose |
| - | - |
| Front-facing, waist-up | The baseline for face and look; the most important one |
| Full body | Costume and build |
| Profile or three-quarter view | Only for characters with heavy screen time |
| Expressions (two or three that the script calls for) | Only for characters who act in close-up |

The order matters: **get the front-facing waist-up image right first**, then use it as a reference image to generate the others; that is how they come out as the same person. For every image you generate, compare the face side by side with the chosen candidate.

For a character with costume changes, generate one front-facing waist-up image per outfit, registered as `reference/<character>-<outfit>`.

List each look reference's asset id and purpose in the character sheet. The storyboard artist and the cinematographer pick their images from this table.

## 5. Acting range
Typical expressions and habitual gestures; things this character would never do.
