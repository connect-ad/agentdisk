import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MarkdownBlocks } from '../src/components-local/Markdown.jsx';
import PostDiagram, { hasDiagram, DIAGRAM_NAMES } from '../src/components-local/PostDiagram.jsx';
import { POSTS, postBySlug, BLOG_ROUTES, BLOG_META } from '../src/lib/blog.js';

/**
 * The inline post diagram and the post that uses it (7 Oct 2026).
 *
 * The parser has seven block types and none of them carry markup, so a
 * diagram rides in on a `diagram` fence whose body is a name. Two things are
 * worth pinning: that a known name draws the picture instead of a code block,
 * and that an unknown one falls back to the code block rather than rendering
 * nothing — a silent hole in a published post is the failure that matters.
 *
 * Every query is scoped to its own render's container. `test/setup.js` does
 * not call testing-library's `cleanup`, so renders accumulate within a file
 * and a document-wide query here would read another case's DOM.
 */

const diagram = name => render(<MemoryRouter><PostDiagram name={name} /></MemoryRouter>).container;
const blocks = bs => render(<MemoryRouter><MarkdownBlocks blocks={bs} /></MemoryRouter>).container;

describe('PostDiagram', () => {
  it('draws a known diagram, labelled for a screen reader', () => {
    const stage = diagram('automation-lanes').querySelector('.pd__stage');
    expect(stage).toBeTruthy();
    expect(stage.getAttribute('role')).toBe('img');
    expect(stage.getAttribute('aria-label')).toMatch(/three automations/i);
  });

  it('returns nothing for a name it does not know', () => {
    expect(diagram('no-such-diagram').innerHTML).toBe('');
  });

  it('reports which names are drawable', () => {
    expect(hasDiagram('automation-lanes')).toBe(true);
    expect(hasDiagram(' automation-lanes ')).toBe(true);
    expect(hasDiagram('no-such-diagram')).toBe(false);
    expect(DIAGRAM_NAMES).toContain('automation-lanes');
  });

  it('names every lane in words, so colour is never the only cue', () => {
    const el = diagram('automation-lanes');
    const named = [...el.querySelectorAll('.pd__lane')].map(n => n.textContent);
    expect(named).toEqual(['Memory', 'Handoff', 'Schedule']);
    // and again in the narrow-screen list, which is what small viewports read
    const heads = [...el.querySelectorAll('.pd__lhead')].map(n => n.textContent);
    expect(heads).toEqual(['Memory', 'Handoff', 'Schedule']);
  });

  it('carries the same facts as a list for narrow screens', () => {
    const el = diagram('automation-lanes');
    expect(el.querySelectorAll('.pd__lsteps').length).toBe(3);
    expect(el.querySelector('.pd__list').textContent).toMatch(/\/memory\//);
  });
});

describe('a diagram fence in a post', () => {
  it('renders the diagram, not a code block', () => {
    const el = blocks([{ type: 'code', lang: 'diagram', text: 'automation-lanes' }]);
    expect(el.querySelector('.pd__stage')).toBeTruthy();
    expect(el.querySelector('pre')).toBeNull();
  });

  it('falls back to a code block when the name is unknown', () => {
    const el = blocks([{ type: 'code', lang: 'diagram', text: 'no-such-diagram' }]);
    expect(el.querySelector('.pd__stage')).toBeNull();
    expect(el.textContent).toMatch(/no-such-diagram/);
  });

  it('leaves an ordinary code block alone', () => {
    const el = blocks([{ type: 'code', lang: 'bash', text: 'curl /v1/whoami' }]);
    expect(el.querySelector('.pd__stage')).toBeNull();
    expect(el.textContent).toMatch(/curl \/v1\/whoami/);
  });
});

describe('the three-automations post', () => {
  const post = postBySlug('three-agent-automations');

  it('is in the blog, with a route and page metadata', () => {
    expect(post).toBeTruthy();
    expect(POSTS.some(p => p.slug === 'three-agent-automations')).toBe(true);
    expect(BLOG_ROUTES).toContain('/blog/three-agent-automations');
    expect(BLOG_META['/blog/three-agent-automations'].description).toBeTruthy();
  });

  it('asks for a diagram that exists', () => {
    const fences = post.blocks.filter(b => b.type === 'code' && b.lang === 'diagram');
    expect(fences.length).toBeGreaterThan(0);
    for (const f of fences) expect(hasDiagram(f.text)).toBe(true);
  });

  it('carries an FAQ, so the post writes its own FAQPage data', () => {
    expect(post.faq.length).toBeGreaterThan(0);
    expect(post.faq.every(e => e.q && e.a)).toBe(true);
  });

  it('types no hostname that the build should have supplied', () => {
    const text = JSON.stringify(post.blocks);
    expect(text).not.toMatch(/\{\{(API_BASE|MCP_ENDPOINT)\}\}/);
    expect(text).toMatch(/agentdisk\.io/);
  });

  it('does not promise the unpublished CLI', () => {
    expect(JSON.stringify(post.blocks)).not.toMatch(/npx agentdisk/);
  });
});
