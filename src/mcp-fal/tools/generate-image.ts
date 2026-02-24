import { z } from 'zod';
import { fal } from '@fal-ai/client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const MODEL_IDS = {
  schnell: 'fal-ai/flux/schnell',
  dev: 'fal-ai/flux/dev',
} as const;

interface FalImage {
  url: string;
  width: number;
  height: number;
  content_type: string;
}

interface FalResult {
  images: FalImage[];
}

export function registerGenerateImage(server: McpServer) {
  server.tool(
    'generate_image',
    'Generate an image from a text prompt using fal.ai FLUX models',
    {
      prompt: z.string().describe('Text description of the image to generate'),
      model: z.enum(['schnell', 'dev']).default('schnell')
        .describe('schnell = fast 4-step generation, dev = higher quality 28-step generation'),
      image_size: z.enum([
        'square_hd',
        'square',
        'landscape_4_3',
        'landscape_16_9',
        'portrait_4_3',
        'portrait_16_9',
      ]).default('square').describe('Output image dimensions'),
      num_images: z.number().int().min(1).max(4).default(1)
        .describe('Number of images to generate'),
    },
    async ({ prompt, model, image_size, num_images }) => {
      if (!process.env.FAL_KEY) {
        throw new Error('FAL_KEY environment variable is required');
      }

      const result = await fal.subscribe(MODEL_IDS[model], {
        input: { prompt, image_size, num_images },
      }) as unknown as { data: FalResult };

      const images = result.data.images;

      const urlText = images.map((img, i) =>
        `Image ${i + 1}: ${img.url} (${img.width}x${img.height})`
      ).join('\n');

      const imageBlocks = await Promise.all(
        images.map(async (img) => {
          const response = await fetch(img.url);
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          return {
            type: 'image' as const,
            data: base64,
            mimeType: (img.content_type ?? 'image/jpeg') as string,
          };
        }),
      );

      return {
        content: [
          { type: 'text' as const, text: urlText },
          ...imageBlocks,
        ],
      };
    },
  );
}
