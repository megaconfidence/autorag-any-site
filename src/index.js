import { WorkflowEntrypoint } from 'cloudflare:workers';
import puppeteer from '@cloudflare/puppeteer';
import slugify from '@sindresorhus/slugify';

const LIVE_ORIGIN = 'confidence.sh';
const WORKER_ORIGIN = 'localhost:8787';

class AttributeRewriter {
	constructor(attributeName) {
		this.attributeName = attributeName;
	}
	element(element) {
		const attribute = element.getAttribute(this.attributeName);
		if (attribute) {
			element.setAttribute(this.attributeName, attribute.replace(LIVE_ORIGIN, WORKER_ORIGIN));
		}
	}
}

export class AutoragCrawler extends WorkflowEntrypoint {
	async run(event, step) {
		const { urlString } = event.payload;
		const fileSlug = `${slugify(urlString)}.html`;

		await step.do('is page crawled?', async () => {
			const isExist = await this.env.AUTORAG_BUCKET.head(fileSlug);
			if (isExist) throw new NonRetryableError('page already crawled');
		});

		const page = await step.do('render webpage', async () => {
			const browser = await puppeteer.launch(this.env.BROWSER);
			const page = await browser.newPage();
			await page.goto(urlString);
			const html = await page.content();
			await browser.close();
			return html;
		});

		await step.do('save page to auto-rag bucket', async () => {
			await this.env.AUTORAG_BUCKET.put(fileSlug, page);
		});
	}
}

export default {
	async fetch(request, env, ctx) {
		const rewriter = new HTMLRewriter().on('a', new AttributeRewriter('href')).on('img', new AttributeRewriter('src'));

		const url = new URL(request.url);
		if (url.hostname.includes('localhost')) url.port = '';
		url.hostname = LIVE_ORIGIN;
		const urlString = url.toString();

		await env.AUTORAG_CRAWLER.create({ params: { urlString } });
		const page = await fetch(urlString, request);

		const contentType = page.headers.get('Content-Type');

		if (contentType?.startsWith('text/html')) return rewriter.transform(page);
		return page;
	},
};
