/**
 * The models, as the server needs them. One interface per kind of output,
 * each as small as the providers allow:
 *
 *   video   takes minutes: submit, then poll, then save; a submitted generation can be called off
 *   image   takes seconds: one call
 *
 * A provider writes the files itself, where the request says: some hand out a
 * URL to download, others (a CLI) save a file of their own accord.
 *
 * To add a model: implement the interface in a file of its own and name it in
 * the registry in server.ts. Nothing else knows which model is in use.
 */

/** What to generate, in no provider's terms. An image is a file path or a URL. */
export type VideoRequest = {
  prompt: string;
  /** The video starts on this image. */
  firstFrame?: string;
  /** With `firstFrame`: the video ends on this image. */
  lastFrame?: string;
  /** Images the video should stay consistent with (a character, a place). Not together with first/last frame. */
  references?: string[];
  /** Seconds. */
  duration?: number;
  /** "480p", "720p", "1080p", … */
  resolution?: string;
  /** "16:9", "9:16", "1:1", … */
  ratio?: string;
  seed?: number;
  /** Whether sound is generated with the picture, where the model can. */
  audio?: boolean;
  /** The last frame will be asked for too (`save` with `lastFrame`). */
  wantLastFrame?: boolean;
};

export type VideoStatus = { status: "pending" | "succeeded" } | { status: "failed"; error: string };

export interface VideoProvider {
  /** The model in use and its limits, in a sentence or two. The agent reads it in the tool's description. */
  readonly about: string;
  /** Start a generation. Answers the provider's id of it. */
  submit(request: VideoRequest): Promise<string>;
  poll(id: string): Promise<VideoStatus>;
  /** Write the finished video to `to.video` and, if asked and there is one, its last frame to `to.lastFrame`. */
  save(id: string, to: { video: string; lastFrame?: string }): Promise<{ seed?: number; lastFrame: boolean }>;
  /**
   * Nobody wants the result any more: stop it if the provider still can, so it is not paid for.
   * Answers whether it was stopped; false means it will finish, and be billed, regardless.
   */
  cancel(id: string): Promise<boolean>;
}

export type ImageRequest = {
  prompt: string;
  /** Images to work from or stay consistent with. */
  references?: string[];
  /** A resolution tier ("2K") or exact pixels ("2048x1152"); which are allowed depends on the model. */
  size?: string;
  /** The file to write. */
  output: string;
};

export interface ImageProvider {
  readonly about: string;
  generate(request: ImageRequest, signal: AbortSignal): Promise<void>;
}

/** A provider is made from the environment the server was started with: that is where a role's settings are. */
export type Factory<Provider> = (env: NodeJS.ProcessEnv) => Provider;
