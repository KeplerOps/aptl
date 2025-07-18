// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
// @ts-ignore: TypeScript can't find declaration but module exists and builds correctly
import { expandTilde } from './utils.js';

// Schema for individual instance configuration
export const InstanceSchema = z.object({
  public_ip: z.string().ip(),
  private_ip: z.string().ip(),
  ssh_key: z.string(),
  ssh_user: z.string(),
  instance_type: z.string(),
  enabled: z.boolean().optional().default(true),
  ports: z.record(z.number()).optional()
});

// Schema for disabled instance
export const DisabledInstanceSchema = z.object({
  enabled: z.literal(false)
});

// Schema for network configuration
const NetworkSchema = z.object({
  vpc_cidr: z.string(),
  subnet_cidr: z.string(),
  allowed_ip: z.string()
});

// Schema for MCP server configuration
const MCPConfigSchema = z.object({
  server_name: z.string(),
  allowed_targets: z.array(z.string()),
  max_session_time: z.number(),
  audit_enabled: z.boolean(),
  log_level: z.string()
});

// Main lab configuration schema
const LabConfigSchema = z.object({
  version: z.string(),
  generated: z.string(),
  lab: z.object({
    name: z.string(),
    vpc_cidr: z.string(),
    project: z.string().optional(),
    environment: z.string().optional()
  }),
  instances: z.object({
    siem: z.union([InstanceSchema, DisabledInstanceSchema]),
    victim: z.union([InstanceSchema, DisabledInstanceSchema]),
    kali: z.union([InstanceSchema, DisabledInstanceSchema])
  }),
  network: NetworkSchema,
  mcp: MCPConfigSchema
});

export type LabConfig = z.infer<typeof LabConfigSchema>;
export type Instance = z.infer<typeof InstanceSchema>;

/**
 * Find the Terraform root directory by searching upward for terraform files
 */
function findTerraformRoot(): string {
  let currentDir = process.cwd();
  console.error(`[MCP] findTerraformRoot starting from: ${currentDir}`);
  
  // First, try known workspace locations (fixes WSL/Windows path issues)
  const knownLocations = [
    '/home/atomik/src/aptl',  // Expected workspace location
    '/home/atomik/src/aptl/infrastructure',  // Direct infrastructure path
  ];
  
  // Check known locations first
  for (const location of knownLocations) {
    console.error(`[MCP] Checking known location: ${location}`);
    
    if (existsSync(location)) {
      const mainTf = resolve(location, 'main.tf');
      const outputsTf = resolve(location, 'outputs.tf');
      
      console.error(`[MCP] Files exist: main.tf=${existsSync(mainTf)}, outputs.tf=${existsSync(outputsTf)}`);
      
      if (existsSync(mainTf) || existsSync(outputsTf)) {
        console.error(`[MCP] Found terraform files in known location: ${location}`);
        return location;
      }
    }
  }
  
  // Fall back to original search logic starting from current directory
  const maxDepth = 10; // Prevent infinite loops
  let depth = 0;
  
  while (depth < maxDepth) {
    console.error(`[MCP] Checking directory (depth ${depth}): ${currentDir}`);
    
    // Check for terraform files in current directory
    const mainTf = resolve(currentDir, 'main.tf');
    const outputsTf = resolve(currentDir, 'outputs.tf');
    
    // Check for infrastructure directory with terraform files
    const infraMainTf = resolve(currentDir, 'infrastructure', 'main.tf');
    const infraOutputsTf = resolve(currentDir, 'infrastructure', 'outputs.tf');
    
    console.error(`[MCP] Checking files: ${mainTf}, ${outputsTf}, ${infraMainTf}, ${infraOutputsTf}`);
    console.error(`[MCP] File exists: main.tf=${existsSync(mainTf)}, outputs.tf=${existsSync(outputsTf)}, infra/main.tf=${existsSync(infraMainTf)}, infra/outputs.tf=${existsSync(infraOutputsTf)}`);
    
    if (existsSync(mainTf) || existsSync(outputsTf)) {
      console.error(`[MCP] Found terraform files in: ${currentDir}`);
      return currentDir;
    }
    
    if (existsSync(infraMainTf) || existsSync(infraOutputsTf)) {
      const terraformRoot = resolve(currentDir, 'infrastructure');
      console.error(`[MCP] Found terraform files in infrastructure subdirectory: ${terraformRoot}`);
      return terraformRoot;
    }
    
    // Move up one directory
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    
    currentDir = parentDir;
    depth++;
  }
  
  throw new Error(
    `Could not find Terraform root directory. Searched for main.tf or outputs.tf in current directory, infrastructure/ subdirectory, and parents. Starting directory was: ${process.cwd()}.`
  );
}

/**
 * Load lab configuration from Terraform output
 */
export async function loadLabConfig(): Promise<LabConfig> {
  try {
    // Find the terraform root directory
    const terraformRoot = findTerraformRoot();
    
    // Get terraform output as JSON
    const terraformOutput = execSync('terraform output -json lab_config_json', {
      encoding: 'utf8',
      cwd: terraformRoot,
      timeout: 10000
    });

    // Parse the JSON (terraform output wraps the actual JSON in quotes)
    const outputData = JSON.parse(terraformOutput.trim());
    const configJson = JSON.parse(outputData);

    // Validate the configuration
    const config = LabConfigSchema.parse(configJson);

    // Expand tilde paths for SSH keys
    if ('ssh_key' in config.instances.siem && config.instances.siem.ssh_key.startsWith('~')) {
      config.instances.siem.ssh_key = expandTilde(config.instances.siem.ssh_key);
    }
    if ('ssh_key' in config.instances.victim && config.instances.victim.ssh_key.startsWith('~')) {
      config.instances.victim.ssh_key = expandTilde(config.instances.victim.ssh_key);
    }
    if ('ssh_key' in config.instances.kali && config.instances.kali.ssh_key.startsWith('~')) {
      config.instances.kali.ssh_key = expandTilde(config.instances.kali.ssh_key);
    }

    return config;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load lab configuration from Terraform: ${error.message}`);
    }
    throw new Error('Unknown error loading lab configuration');
  }
}

/**
 * Check if target is in allowed CIDR ranges
 */
export function isTargetAllowed(target: string, allowedCidrs: string[]): boolean {
  // For now, implement basic CIDR checking
  // In production, you'd use a proper CIDR library
  for (const cidr of allowedCidrs) {
    if (isIpInCidr(target, cidr)) {
      return true;
    }
  }
  return false;
}

/**
 * Basic CIDR check (simplified implementation)
 */
function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, prefixLength] = cidr.split('/');
  const prefix = parseInt(prefixLength, 10);
  
  const ipNum = ipToNumber(ip);
  const networkNum = ipToNumber(network);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  
  return (ipNum & mask) === (networkNum & mask);
}

/**
 * Convert IP address to number
 */
function ipToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

/**
 * Select SSH credentials based on target IP and lab configuration
 */
export function selectCredentials(target: string, config: LabConfig, defaultUsername: string = 'kali'): { sshKey: string; username: string } {
  // Auto-detect instance and credentials
  if ('ssh_key' in config.instances.siem && 
      (config.instances.siem.public_ip === target || config.instances.siem.private_ip === target)) {
    return {
      sshKey: config.instances.siem.ssh_key,
      username: config.instances.siem.ssh_user
    };
  } else if ('ssh_key' in config.instances.victim && 
             (config.instances.victim.public_ip === target || config.instances.victim.private_ip === target)) {
    return {
      sshKey: config.instances.victim.ssh_key,
      username: config.instances.victim.ssh_user
    };
  } else if ('ssh_key' in config.instances.kali && 
             (config.instances.kali.public_ip === target || config.instances.kali.private_ip === target)) {
    return {
      sshKey: config.instances.kali.ssh_key,
      username: config.instances.kali.ssh_user
    };
  } else {
    // Default to Kali credentials for unknown targets in allowed ranges
    if (!('ssh_key' in config.instances.kali)) {
      throw new Error('Kali instance not available for SSH operations');
    }
    return {
      sshKey: config.instances.kali.ssh_key,
      username: defaultUsername
    };
  }
} 