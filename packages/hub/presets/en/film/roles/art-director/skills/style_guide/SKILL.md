---
description: Create the visual style guide for the whole film
produces: style_guide
inputs: brief, script
---
# Style guide

Register as `style_guide/<title>`, in markdown. There is exactly one for the whole film. Deliver it in two rounds, both as versions of this one asset.

**Round one: directions.** Write section 0 only and hand it to the director, who asks the user to choose. Until the direction is settled, do not write the later sections and do not generate scene reference images.

**Round two: final.** After the user has chosen a direction, complete sections 1–8 accordingly.

## 0. Direction samples (round one)
Offer two or three directions that are **clearly distinct**, not three minor variations of one direction. For each direction:

- A name and one sentence ("Cool realism: like a late-night documentary, mostly blue-gray, almost no warm colors").
- One sample frame: the same scene and the same composition with only the style changed, so that what is being compared is the style. Register it as `reference/style-<direction>`.
- Why it suits this story, and what it costs ("many night scenes; the characters' faces tend to go dark").

End with your recommendation.

## 1. Overall look
One paragraph: what this film looks like. Position it by film genre, era, and medium (film stock, digital, animation).

## 2. Color
- Primary, secondary, and accent colors, each with a color name and an approximate color value.
- Tonal relationships: high-key or low-key, strong or weak contrast.
- Rules for variation between sections (for example, "flashbacks are warmer and desaturated").

## 3. Lighting
The quality (hard / soft), direction, and color temperature of the key light; whether there are practical light sources; how night scenes are handled.

## 4. Camera language
Typical shot sizes and depth of field, camera height, movement (static, slow push-in, follow, handheld feel), compositional habits.

## 5. Texture
Grain, sharpness, lens characteristics (halation, distortion).

## 6. What to avoid
What should not appear in this film: certain colors, certain kinds of camera movement, an overly effects-heavy look, text in the frame.

## 7. Style suffix (required)
Condense all of the above into **one passage of 25–50 words**, which the cinematographer appends verbatim to the end of every shot's prompt. Write only visual traits, no plot.

> Realistic cinematic look, low-key lighting, warm tungsten light with teal shadows, shallow depth of field, film grain, slow and steady camera movement, restrained color, no text in frame.

## 8. Scene design
For each main location in the script's location list: spatial layout, key furnishings, light source positions, color. Generate one **scene reference image** per location (an empty shot, with no characters), registered as `reference/scene-<scene>`.
