---
description: Produce candidate looks for the main characters, for the director and user to cast from
produces: casting
inputs: brief, script, style_guide
---
# Casting

One per main character, registered as `casting/<character>`, in markdown. It contains candidates only, nothing final: the character sheet is made only after the user has chosen (skill `character`).

First distinguish casting an identity from choosing a look for an established person. When the user specifies a person or supplies identity references, preserve their face and identity; requested look candidates vary costume, hair styling and performance rather than the actor. If the user has already chosen a usable look and wants no candidates, record its source and proceed to the character sheet. Supporting characters may go straight to a character sheet. Whether real-person references are accepted depends on this film's model documentation and technical check; report verified restrictions rather than importing another platform's rules.

## 1. First write down what this character requires
Copy the fixed conditions from the script: age range, gender, role, and any traits the story needs ("should look more tired than their actual age"). Candidates vary only within these conditions.

## 2. Produce three to five candidates
When identity is open, candidates may vary face shape, temperament and apparent age within the script's conditions. When identity is fixed, distinguish candidates along the requested styling dimensions while preserving the face and stable traits. Follow the task and authorised scope for candidate count; do not generate extras to meet a quota.

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
Arrange the original candidates side by side without stretching, keeping their individual asset references, to compare style and recognisability. Register it as `candidate/lineup-<n>`. A comparison montage preserves the faces; generate an actual group image separately when requested and check it. If established people are hard to distinguish, adjust styling and composition before considering any change of identity.

## What to include in the result
Each character's candidate asset ids, and your recommendation. Do not decide yourself: the director asks the user to choose.
