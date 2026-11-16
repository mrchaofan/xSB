---
description: Produce candidate looks for the main characters, for the director and user to cast from
produces: casting
inputs: brief, script, style_guide
---
# Casting

One per main character, registered as `casting/<character>`, in markdown. It contains candidates only, nothing final: the character sheet is made only after the user has chosen (skill `character`).

Cast main characters only. Supporting characters and characters who appear in only one or two shots go straight to a character sheet. For a character whose look the user specified in the brief or supplied a photo for, do not produce candidates; register the user's image as the sole candidate and note where it came from.

## 1. First write down what this character requires
Copy the fixed conditions from the script: age range, gender, role, and any traits the story needs ("should look more tired than their actual age"). Candidates vary only within these conditions.

## 2. Produce three to five candidates
The candidates must be **clearly distinct** from one another: different face shapes, temperaments, and apparent ages, so the choice means something. Do not offer three minor variations of the same face.

So that the comparison is only about the person, shoot every candidate the same way:

- Front-facing, waist-up, looking straight into the camera, with a calm expression.
- Plain light gray background, even and soft frontal light.
- The plainest possible clothing (a solid-color top), not yet the character's look in the film.
- The same aspect ratio.

Write the prompts as described in the skill `reference-image`. Register each image as `candidate/<character>-<n>`, with the prompt in the description.

An image takes a few seconds to generate: if a candidate's face is distorted or does not meet the conditions, regenerate it right away; do not put substandard images among the candidates.

## 3. Candidate table

| Candidate | Asset | In one sentence | Why it fits | Concerns |
| - | - | - | - | - |
| 1 | `candidate/aning-1` | Lean face, tired eyes, early thirties | Fits her situation of "just off the night shift" | Comes across as cold; the release at the end may not feel warm enough |

End with your recommendation and the reason.

## 4. Multiple main characters
Put the candidates you recommend for each character side by side in a lineup-style comparison image (same background, same lighting), and check whether they look like people from the same film when standing together, and whether they are easy to tell apart. Register it as `candidate/lineup-<n>`. If two of them look too much alike, replace one.

## What to include in the result
Each character's candidate asset ids, and your recommendation. Do not decide yourself: the director asks the user to choose.
