// ============================================================================
// Motor WebGPU + Compute & Fragment Shaders WGSL para O'Reilly Pulse
// ============================================================================
// 1. Compute Shader WGSL (@workgroup_size(64) con vec4<f32> SIMD) que calcula
//    en paralelo en la GPU la matriz de similitud coseno y peso editorial
//    entre los vectores característicos 64-D de las Áreas Técnicas de O'Reilly.
// 2. Render Pipeline WGSL que dibuja en tiempo real el Radar de Conocimiento
//    e Impacto del ecosistema O'Reilly (con respaldo automático en Canvas 2D).

const PULSE_SIMILARITY_COMPUTE_WGSL = /* wgsl */ `
struct ComputeParams {
  num_clusters : u32,
  dim_vec4     : u32, // 64 dims = 16 bloques vec4<f32>
  _pad0        : u32,
  _pad1        : u32,
};

@group(0) @binding(0) var<uniform> params : ComputeParams;
@group(0) @binding(1) var<storage, read> vectors : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> weights : array<f32>;
@group(0) @binding(3) var<storage, read_write> affinity_out : array<f32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let idx = gid.x;
  let n = params.num_clusters;
  if (idx >= n * n) {
    return;
  }

  let row = idx / n;
  let col = idx % n;
  let stride = params.dim_vec4;

  var dot_acc : f32 = 0.0;
  var norm_a  : f32 = 0.0;
  var norm_b  : f32 = 0.0;

  let base_a = row * stride;
  let base_b = col * stride;

  for (var i : u32 = 0u; i < stride; i = i + 1u) {
    let va = vectors[base_a + i];
    let vb = vectors[base_b + i];
    dot_acc = dot_acc + dot(va, vb);
    norm_a = norm_a + dot(va, va);
    norm_b = norm_b + dot(vb, vb);
  }

  let denom = sqrt(max(norm_a * norm_b, 1e-6));
  let cosine = clamp(dot_acc / denom, 0.0, 1.0);
  let boost = sqrt(max(weights[row] * weights[col], 0.01));
  affinity_out[idx] = cosine * 0.72 + clamp(boost, 0.0, 1.0) * 0.28;
}
`;

const PULSE_RADAR_RENDER_WGSL = /* wgsl */ `
struct RadarUniforms {
  num_nodes : f32,
  aspect    : f32,
  hover_idx : f32,
  time_sec  : f32,
};

struct NodeData {
  // x: pos_x (0..1), y: pos_y (0..1), z: impact (0..1), w: hue_seed (0..1)
  meta : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : RadarUniforms;
@group(0) @binding(1) var<storage, read> nodes : array<NodeData>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv        : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 3.0,  1.0)
  );
  let p = positions[vid];
  var out : VSOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let p = vec2<f32>(uv.x * u.aspect, uv.y);

  // Fondo técnico oscuro/editorial con anillos de radar concéntricos
  var bg = mix(vec3<f32>(0.065, 0.082, 0.125), vec3<f32>(0.035, 0.045, 0.075), uv.y);
  let center_radar = vec2<f32>(0.5 * u.aspect, 0.5);
  let dist_center = distance(p, center_radar);
  let ring = abs(fract(dist_center * 4.5) - 0.5);
  let ring_line = smoothstep(0.475, 0.5, ring);
  bg = mix(bg, vec3<f32>(0.18, 0.22, 0.32), ring_line * 0.35);

  let grid_x = abs(fract(p.x * 10.0) - 0.5);
  let grid_y = abs(fract(p.y * 5.0) - 0.5);
  let grid_line = smoothstep(0.488, 0.5, max(grid_x, grid_y));
  bg = mix(bg, vec3<f32>(0.14, 0.18, 0.26), grid_line * 0.3);

  let count = u32(clamp(u.num_nodes, 0.0, 16.0));
  var field_energy : f32 = 0.0;
  var color_acc = vec3<f32>(0.0);

  for (var i : u32 = 0u; i < count; i = i + 1u) {
    let nd = nodes[i].meta;
    let center = vec2<f32>(nd.x * u.aspect, nd.y);
    let impact = clamp(nd.z, 0.2, 1.0);
    let seed = nd.w;

    let d = distance(p, center);
    let base_r = mix(0.065, 0.155, impact);
    let is_hovered = abs(f32(i) - u.hover_idx) < 0.25;
    let r = select(base_r, base_r * 1.22, is_hovered);

    let glow = exp(- (d * d) / (2.0 * (r * 0.88) * (r * 0.88)));
    field_energy = field_energy + glow * impact * 0.68;

    let node_col = mix(
      vec3<f32>(0.85, 0.14, 0.18), // Carmesí O'Reilly
      vec3<f32>(0.15, 0.55, 0.95), // Azul Arquitectura
      fract(seed * 3.17)
    );
    color_acc = color_acc + node_col * glow * impact;

    // Anillo SDF nítido por clúster
    let ring_d = abs(d - r * 0.62);
    let ring_alpha = smoothstep(0.009, 0.001, ring_d);
    let ring_col = select(node_col, vec3<f32>(1.0, 0.86, 0.35), is_hovered);
    bg = mix(bg, ring_col, ring_alpha * 0.85);
  }

  let final_col = clamp(bg + color_acc * 0.42, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(final_col, 1.0);
}
`;

class OReillyPulseWebGPUEngine {
  constructor() {
    this.device = null;
    this.computePipeline = null;
    this.renderPipeline = null;
    this.format = null;
    this.ready = false;
    this.hoverIndex = -1;
    this.nodesLayout = [];
    this.affinityMatrix = [];
    this.lastComputeMs = 0;
  }

  async init() {
    if (this.ready) return true;
    if (!navigator.gpu) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      this.device = await adapter.requestDevice();
      this.format = navigator.gpu.getPreferredCanvasFormat();

      const computeMod = this.device.createShaderModule({ code: PULSE_SIMILARITY_COMPUTE_WGSL });
      this.computePipeline = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module: computeMod, entryPoint: 'cs_main' }
      });

      const renderMod = this.device.createShaderModule({ code: PULSE_RADAR_RENDER_WGSL });
      this.renderPipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: renderMod, entryPoint: 'vs_main' },
        fragment: {
          module: renderMod,
          entryPoint: 'fs_main',
          targets: [{ format: this.format }]
        },
        primitive: { topology: 'triangle-list' }
      });

      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  async computeAffinityAndRender(canvas, clusters, onHoverCluster) {
    if (!canvas || !Array.isArray(clusters) || clusters.length === 0) return;
    const n = Math.min(clusters.length, 16);
    const t0 = performance.now();

    // Posicionar nodos en el radar de forma armónica
    this.nodesLayout = clusters.slice(0, n).map((c, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const radiusX = n === 1 ? 0 : 0.28 + (i % 2) * 0.07;
      const radiusY = n === 1 ? 0 : 0.27 + (i % 2) * 0.06;
      const x = Math.min(0.88, Math.max(0.12, 0.5 + Math.cos(angle) * radiusX));
      const y = Math.min(0.84, Math.max(0.16, 0.5 + Math.sin(angle) * radiusY));
      return {
        index: i,
        cluster: c,
        x,
        y,
        impact: Math.min(1.0, Math.max(0.28, c.weight || 0.5)),
        seed: (i + 1) / (n + 1)
      };
    });

    const gpuOk = await this.init();
    if (gpuOk && this.device) {
      try {
        const strideVec4 = 16; // 64 floats = 16 vec4
        const vecData = new Float32Array(n * 64);
        const weightData = new Float32Array(n);

        for (let i = 0; i < n; i++) {
          const v = clusters[i].vector64 || [];
          for (let d = 0; d < 64; d++) {
            vecData[i * 64 + d] = Number(v[d] || 0);
          }
          weightData[i] = Number(clusters[i].weight || 0.5);
        }

        const paramBuf = this.device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(paramBuf, 0, new Uint32Array([n, strideVec4, 0, 0]));

        const vecBuf = this.device.createBuffer({
          size: Math.max(64, vecData.byteLength),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(vecBuf, 0, vecData);

        const weightBuf = this.device.createBuffer({
          size: Math.max(16, weightData.byteLength),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(weightBuf, 0, weightData);

        const outByteLen = Math.max(16, n * n * 4);
        const outBuf = this.device.createBuffer({
          size: outByteLen,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        const readBuf = this.device.createBuffer({
          size: outByteLen,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });

        const bg = this.device.createBindGroup({
          layout: this.computePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: paramBuf } },
            { binding: 1, resource: { buffer: vecBuf } },
            { binding: 2, resource: { buffer: weightBuf } },
            { binding: 3, resource: { buffer: outBuf } }
          ]
        });

        const enc = this.device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(this.computePipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil((n * n) / 64));
        pass.end();
        enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outByteLen);
        this.device.queue.submit([enc.finish()]);

        await readBuf.mapAsync(GPUMapMode.READ);
        this.affinityMatrix = Array.from(new Float32Array(readBuf.getMappedRange()).slice(0, n * n));
        readBuf.unmap();
        this.lastComputeMs = Number((performance.now() - t0).toFixed(2));

        this.renderRadarFrame(canvas);
      } catch {
        this.renderCanvas2DFallback(canvas);
      }
    } else {
      this.lastComputeMs = Number((performance.now() - t0).toFixed(2));
      this.renderCanvas2DFallback(canvas);
    }

    // Interacción de puntero sobre los nodos del radar
    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const nx = (ev.clientX - rect.left) / rect.width;
      const ny = (ev.clientY - rect.top) / rect.height;
      let found = -1;
      for (const nd of this.nodesLayout) {
        const dx = nx - nd.x;
        const dy = ny - nd.y;
        if (Math.hypot(dx, dy) < 0.095) {
          found = nd.index;
          break;
        }
      }
      if (found !== this.hoverIndex) {
        this.hoverIndex = found;
        if (this.ready) this.renderRadarFrame(canvas);
        else this.renderCanvas2DFallback(canvas);
        if (typeof onHoverCluster === 'function') {
          onHoverCluster(found >= 0 ? this.nodesLayout[found].cluster : null);
        }
      }
    };
  }

  renderRadarFrame(canvas) {
    if (!this.ready || !this.device) return;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) return this.renderCanvas2DFallback(canvas);

    ctx.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque'
    });

    const n = this.nodesLayout.length;
    const aspect = canvas.width / Math.max(1, canvas.height);

    const uBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(
      uBuf,
      0,
      new Float32Array([n, aspect, this.hoverIndex, performance.now() * 0.001])
    );

    const nodeArr = new Float32Array(Math.max(4, n * 4));
    for (let i = 0; i < n; i++) {
      const nd = this.nodesLayout[i];
      nodeArr[i * 4 + 0] = nd.x;
      nodeArr[i * 4 + 1] = nd.y;
      nodeArr[i * 4 + 2] = nd.impact;
      nodeArr[i * 4 + 3] = nd.seed;
    }

    const nBuf = this.device.createBuffer({
      size: nodeArr.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(nBuf, 0, nodeArr);

    const bg = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uBuf } },
        { binding: 1, resource: { buffer: nBuf } }
      ]
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0.05, g: 0.07, b: 0.11, a: 1.0 },
          storeOp: 'store'
        }
      ]
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  renderCanvas2DFallback(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    for (const nd of this.nodesLayout) {
      const cx = nd.x * w;
      const cy = nd.y * h;
      const r = 18 + nd.impact * 24;
      const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, r * 1.6);
      grad.addColorStop(0, nd.cluster.color || '#dc2626');
      grad.addColorStop(1, 'rgba(15,23,42,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

window.OReillyPulseWebGPUEngine = OReillyPulseWebGPUEngine;
