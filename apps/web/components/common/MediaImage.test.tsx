import { type Media } from "@dopamine/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MediaImage } from "./MediaImage";

/**
 * The media-state component renders the right thing per `media.status` (doc 03 §6):
 *   generating_text  → no hero, "preparing" placeholder box,
 *   generating_media → placeholder hero + a plain "loading" indicator (orderable),
 *   ready            → the final hero image,
 *   degraded         → the kept placeholder hero, NO loading/error chrome (usable).
 */

const hero = {
  url: "http://fake-gen:8090/img/ph/x.svg",
  kind: "image" as const,
  blurhash: null,
  aspect_ratio: 1,
};

function media(status: Media["status"], withHero = true): Media {
  return {
    status,
    hero: withHero ? hero : null,
    alternates: [],
    expected_ready_ms: null,
    generation_id: "gen_1",
  };
}

describe("MediaImage", () => {
  it("generating_text → shows the preparing placeholder, no <img>", () => {
    const { container } = render(
      <MediaImage media={media("generating_text", false)} alt="Widget" />,
    );
    expect(screen.getByText(/preparing/i)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("generating_media → shows the placeholder hero AND a loading indicator", () => {
    const { container } = render(
      <MediaImage media={media("generating_media")} alt="Widget" />,
    );
    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("ready → shows the final hero, no loading indicator", () => {
    const { container } = render(
      <MediaImage media={media("ready")} alt="Widget" />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(hero.url);
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it("degraded → renders the kept hero as usable (no loading/error chrome)", () => {
    const { container } = render(
      <MediaImage media={media("degraded")} alt="Widget" />,
    );
    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });
});
