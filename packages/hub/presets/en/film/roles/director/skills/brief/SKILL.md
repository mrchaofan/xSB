---
description: Turn the user's idea into a one-page creative brief before work starts
produces: brief
---
# Creative brief

There is exactly one for the whole film, registered as `brief/<title>`. It is the shared basis for every department. Any item you cannot fill in means the project has not been thought through yet: go and ask the user.

| Item | How specific | Example |
| - | - | - |
| One-sentence story | Who, wants what, blocked by what, with what outcome | A woman rushing for the last ferry misses it and decides to wait at the landing until dawn |
| What the audience feels afterward | One word to one sentence | A quiet sense of release |
| Running time | Seconds | 60 seconds |
| Aspect ratio | One ratio, the same for the whole film | 16:9 |
| Genre and tone | Live-action realism / animation / commercial...; fast or slow pacing; warm or cool | Realistic, restrained, slow |
| Main characters | How many, one sentence each; whether the user has specified a look or supplied photos | Two: the woman rushing for the ferry, and the ticket clerk. No specified looks |
| Sound | Whether there is dialogue and in what language; whether there is narration; who provides the music | Two lines of Chinese dialogue, mostly ambient sound, no music |
| References | The look of what kind of film (describe the traits; naming titles is optional) | 1990s Chinese-language art-house film, low saturation, barely any handheld feel |
| Delivery specs | Resolution, file format | 1080p, mp4 |
| Generation plan | Which model makes images and which video, reached how (a tool server or a skill); whether xsb keeps their costs and cancelling in hand; whether they fit together (does the video model take the image model's images as first frames); ask the user what you cannot fill in | Images and video through the tool servers of the "Volcengine Ark video" team, held to the budget; the fit to be confirmed by the technical check |
| Cap on generation costs | The most that images and video may cost, as the budget the user set in the settings says; with your estimate as a range | At most 150; estimated 90–130 |
| Reshoots and non-negotiables | Maximum rounds of reshoots; what cannot be compromised | At most three rounds per shot; the characters' faces must stay consistent |

Running time determines scale: a single generated shot usually runs 4–15 seconds, and each shot averages 4–6 seconds in the finished film, so 60 seconds is roughly 10–15 shots and 3–5 scenes. State the order of magnitude of the shot count in the brief, so the departments downstream do not keep making the project bigger.

Estimate the cost as "shots × draft unit price × average generations per shot, plus the finals", written as a range. Take the unit price from the technical check or the provider's price list, not from memory; one not known yet is "after the technical check". When the user has not set a budget in the settings, ask them to before the brief is final: that number is a hard cap, and nothing more is generated once it is reached.

When the generation plan cannot be filled in, because the user has no image or video model the team can use, say so in the brief: this time only the written part can be done (brief, script, shot list), and images and video wait until the user connects models (the "Volcengine Ark video" team, say, or a tool server or skill of their own for the generating roles).

Be honest in the sound item: dialogue and production sound can be generated with the shots, but music and narration require audio files from the user.

When you finish, show the user the full text and ask for user sign-off. Until the user signs off, do not register it and do not dispatch any tasks.
