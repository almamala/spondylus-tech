#!/usr/bin/env node

/**
 * Jekyll HTML Translator using DeepL API
 * 
 * Translates Jekyll HTML files while preserving:
 * - Front matter structure
 * - HTML tags and attributes
 * - File formatting
 * 
 * Usage:
 *   node translate-jekyll.js <input-file> [options]
 * 
 * Options:
 *   --output <file>              Output file path (default: es/<filename>)
 *   --target-lang <lang>         Target language code (default: ES)
 *   --source-lang <lang>         Source language code (default: EN)
 *   --translate-fields <fields>  Comma-separated front matter fields to translate (default: title,description)
 *   --dry-run                    Show character count without translating
 *   --skip-git-check             Skip git status check (not recommended)
 *   --api-tier <free|pro>        API tier to use (default: free)
 * 
 * Environment:
 *   DEEPL_API_KEY               DeepL API authentication key (required)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    inputFile: null,
    outputFile: null,
    targetLang: 'ES',
    sourceLang: 'EN',
    translateFields: ['title', 'description'],
    dryRun: false,
    apiTier: 'free',
    skipGitCheck: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (!arg.startsWith('--')) {
      if (!config.inputFile) {
        config.inputFile = arg;
      }
      continue;
    }

    switch (arg) {
      case '--output':
        config.outputFile = args[++i];
        break;
      case '--target-lang':
        config.targetLang = args[++i];
        break;
      case '--source-lang':
        config.sourceLang = args[++i];
        break;
      case '--translate-fields':
        config.translateFields = args[++i].split(',').map(f => f.trim());
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '--skip-git-check':
        config.skipGitCheck = true;
        break;
      case '--api-tier':
        config.apiTier = args[++i];
        break;
      case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 23).map(l => l.replace(/^ \* ?/, '')).join('\n'));
        process.exit(0);
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  if (!config.inputFile) {
    console.error('Error: Input file required\n');
    console.log('Usage: node translate-jekyll.js <input-file> [options]');
    console.log('       node translate-jekyll.js --help');
    process.exit(1);
  }

  // Auto-generate output path if not specified
  if (!config.outputFile) {
    const basename = path.basename(config.inputFile);
    config.outputFile = path.join('es', basename);
  }

  return config;
}

// Get API key from environment or .env file
function getApiKey() {
  // Check environment variable
  if (process.env.DEEPL_API_KEY) {
    return process.env.DEEPL_API_KEY;
  }

  // Check .env file
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^DEEPL_API_KEY=(.+)$/m);
    if (match) {
      return match[1].trim();
    }
  }

  console.error('\nError: DEEPL_API_KEY not found\n');
  console.error('Please set your DeepL API key:');
  console.error('  1. Set environment variable: export DEEPL_API_KEY=your-key-here');
  console.error('  2. Or create .env file with: DEEPL_API_KEY=your-key-here\n');
  process.exit(1);
}

// Parse Jekyll front matter and content
function parseJekyllFile(content) {
  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  
  if (!frontMatterMatch) {
    throw new Error('No valid Jekyll front matter found (must start with --- and end with ---)');
  }

  const [, frontMatter, htmlContent] = frontMatterMatch;
  
  // Parse YAML front matter into key-value pairs (simple parser)
  const frontMatterLines = frontMatter.split('\n');
  const frontMatterData = {};
  
  for (const line of frontMatterLines) {
    const match = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (match) {
      frontMatterData[match[1]] = match[2];
    }
  }

  return {
    frontMatter: frontMatterData,
    frontMatterRaw: frontMatter,
    content: htmlContent
  };
}

// Call DeepL API
function translateWithDeepL(text, apiKey, targetLang, sourceLang, apiTier = 'free') {
  return new Promise((resolve, reject) => {
    const endpoint = apiTier === 'pro' 
      ? 'api.deepl.com' 
      : 'api-free.deepl.com';

    const postData = JSON.stringify({
      text: [text],
      target_lang: targetLang,
      source_lang: sourceLang,
      tag_handling: 'html',
      outline_detection: false
    });

    const options = {
      hostname: endpoint,
      port: 443,
      path: '/v2/translate',
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const response = JSON.parse(data);
            resolve(response.translations[0].text);
          } catch (err) {
            reject(new Error(`Failed to parse response: ${err.message}`));
          }
        } else {
          reject(new Error(`API request failed (${res.statusCode}): ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

// Reconstruct Jekyll file with translated content
function reconstructFile(originalFrontMatter, translatedFrontMatterData, translatedContent, targetLang) {
  // Build new front matter
  const lines = originalFrontMatter.split('\n');
  const newFrontMatter = lines.map(line => {
    const match = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (match) {
      const key = match[1];
      
      // Replace lang field
      if (key === 'lang') {
        return `lang: ${targetLang.toLowerCase().substring(0, 2)}`;
      }
      
      // Replace translated fields
      if (translatedFrontMatterData[key]) {
        return `${key}: ${translatedFrontMatterData[key]}`;
      }
    }
    return line;
  }).join('\n');

  return `---\n${newFrontMatter}\n---\n${translatedContent}`;
}

// Count characters for dry run
function countCharacters(content, frontMatterData, translateFields) {
  let total = content.length;
  
  for (const field of translateFields) {
    if (frontMatterData[field]) {
      total += frontMatterData[field].length;
    }
  }
  
  return total;
}

// Check git status for uncommitted changes
function checkGitStatus() {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    
    if (status.trim()) {
      console.error('\n⚠️  Uncommitted changes detected.');
      console.error('Please commit your changes before translating to preserve state.\n');
      console.error('Run: git add . && git commit -m "your message"\n');
      process.exit(1);
    }
  } catch (error) {
    // Git not available or not a git repo - warn but continue
    console.warn('⚠️  Unable to check git status. Make sure to save your work before translating.\n');
  }
}

// Main execution
async function main() {
  const config = parseArgs();

  // Check git status first (unless skipped)
  if (!config.skipGitCheck) {
    checkGitStatus();
  }

  const apiKey = getApiKey();

  // Read input file
  if (!fs.existsSync(config.inputFile)) {
    console.error(`Error: File not found: ${config.inputFile}`);
    process.exit(1);
  }

  console.log(`\n📄 Reading: ${config.inputFile}`);
  const fileContent = fs.readFileSync(config.inputFile, 'utf8');

  // Parse Jekyll file
  let parsed;
  try {
    parsed = parseJekyllFile(fileContent);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  // Calculate character count
  const charCount = countCharacters(parsed.content, parsed.frontMatter, config.translateFields);
  console.log(`📊 Character count: ${charCount.toLocaleString()}`);

  if (config.dryRun) {
    console.log('\n✓ Dry run complete (no translation performed)');
    console.log(`  Fields to translate: ${config.translateFields.join(', ')}`);
    console.log(`  Output would be: ${config.outputFile}`);
    return;
  }

  // Translate content
  console.log(`\n🌐 Translating content (${config.sourceLang} → ${config.targetLang})...`);
  let translatedContent;
  try {
    translatedContent = await translateWithDeepL(
      parsed.content,
      apiKey,
      config.targetLang,
      config.sourceLang,
      config.apiTier
    );
  } catch (err) {
    console.error(`\nTranslation failed: ${err.message}`);
    process.exit(1);
  }

  // Translate front matter fields
  const translatedFrontMatterData = {};
  for (const field of config.translateFields) {
    if (parsed.frontMatter[field]) {
      console.log(`🌐 Translating front matter field: ${field}...`);
      try {
        translatedFrontMatterData[field] = await translateWithDeepL(
          parsed.frontMatter[field],
          apiKey,
          config.targetLang,
          config.sourceLang,
          config.apiTier
        );
      } catch (err) {
        console.error(`\nFailed to translate field "${field}": ${err.message}`);
        process.exit(1);
      }
    }
  }

  // Reconstruct file
  const translatedFile = reconstructFile(
    parsed.frontMatterRaw,
    translatedFrontMatterData,
    translatedContent,
    config.targetLang
  );

  // Ensure output directory exists
  const outputDir = path.dirname(config.outputFile);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write output file
  fs.writeFileSync(config.outputFile, translatedFile, 'utf8');
  console.log(`\n✓ Translation complete!`);
  console.log(`📝 Written to: ${config.outputFile}`);
  console.log(`📊 Total characters used: ~${charCount.toLocaleString()}\n`);
}

// Run
main().catch(err => {
  console.error(`\nUnexpected error: ${err.message}`);
  process.exit(1);
});
