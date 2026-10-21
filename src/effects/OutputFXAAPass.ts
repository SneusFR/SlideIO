import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";

/**
 * GIVRE post chain, `?diag=fused` (GivrePostChain): the sRGB output
 * conversion folded INTO the FXAA pass — FXAA reads the linear world target
 * and writes the canvas; no intermediate image is written and read back.
 *
 * A first version (a63fb44, removed in 6094aa6) let the hardware filter the
 * LINEAR image: FXAA's bilinear taps (edge search between two rows, final
 * blend between two texels) then averaged linear values instead of sRGB
 * ones — 6-9 % of the pixels changed, up to 174 levels. Here every read is
 * a texelFetch of ONE texel, converted exactly like OutputPass does
 * (three's `toneMapping()` when the renderer has one, `linearToOutputTexel()`
 * = the canvas sRGB transfer), then rounded to half precision like the
 * RGBA16F target the old chain stored it in; FXAA's filtering is done by
 * hand on those converted texels, at three's FXAA sample positions
 * (three r185 FXAAShader, same constants, same order of operations): the
 * same luminances, the same decisions, the same blends. What can still
 * differ: the hardware's filter weights (sub-texel precision, typically 8
 * bits) on the ONE fractional tap of the final blend — ≤ 1 level, on some
 * anti-aliased edge pixels only (the edge-search taps sit at 0 or ½ texel,
 * exact in any precision). `SUBTEXEL_BITS` quantizes the manual weights to
 * mimic a given hardware; undefined = exact weights.
 *
 * Cost: no 8 B/px intermediate write + read (RGBA16F), but each pixel
 * converts 5 texels (the cross of FXAA's neighbourhood: enough for its skip
 * test) instead of 1, and an anti-aliased edge pixel up to ~55. On a
 * bandwidth-bound iGPU this trades 16 B/px of memory traffic for ALU
 * (3 pow per texel): measure it (GivrePostChain, `?gpu`).
 *
 * Only ever drawn to the canvas (linearToOutputTexel is the canvas
 * conversion there); same uniforms as three's FXAAPass.
 */
const OUTPUT_FXAA_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 resolution;
varying vec2 vUv;

#define EDGE_STEP_COUNT 6
#define EDGE_GUESS 8.0
#define EDGE_STEPS 1.0, 1.5, 2.0, 2.0, 2.0, 4.0
const float edgeSteps[EDGE_STEP_COUNT] = float[EDGE_STEP_COUNT]( EDGE_STEPS );

float _ContrastThreshold = 0.0312;
float _RelativeThreshold = 0.063;
float _SubpixelBlending = 1.0;

const vec3 LUMA = vec3( 0.3, 0.59, 0.11 );

ivec2 texMax;
vec2 texSizePx;

// One texel of the old chain's intermediate image: OutputPass's conversion,
// stored in an RGBA16F target (hence the rounding to half precision).
vec4 OutputTexel( ivec2 p ) {
	vec4 c = texelFetch( tDiffuse, clamp( p, ivec2( 0 ), texMax ), 0 );
	#ifdef TONE_MAPPING
	c.rgb = toneMapping( c.rgb );
	#endif
	c = linearToOutputTexel( c );
	#ifdef NO_HALF_ROUNDING
	return c; // (DEV A/B: what the half-precision rounding accounts for)
	#else
	return vec4( unpackHalf2x16( packHalf2x16( c.rg ) ), unpackHalf2x16( packHalf2x16( c.ba ) ) );
	#endif
}

float LumaAt( ivec2 p ) {
	return dot( OutputTexel( p ).rgb, LUMA );
}

vec2 Weights( vec2 f ) {
	#ifdef SUBTEXEL_BITS
	const float k = float( 1 << SUBTEXEL_BITS );
	return floor( f * k + 0.5 ) / k;
	#else
	return f;
	#endif
}

// What texture( tDiffuse, uv ) returned in the old chain (bilinear filter of
// the converted image, clamp to edge), as a luminance.
float LumaBilinear( vec2 uv ) {
	vec2 st = uv * texSizePx - 0.5;
	vec2 i = floor( st );
	vec2 f = Weights( st - i );
	ivec2 q = ivec2( i );
	vec3 a = OutputTexel( q ).rgb;
	vec3 b = OutputTexel( q + ivec2( 1, 0 ) ).rgb;
	vec3 c = OutputTexel( q + ivec2( 0, 1 ) ).rgb;
	vec3 d = OutputTexel( q + ivec2( 1, 1 ) ).rgb;
	return dot( mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y ), LUMA );
}

// Final read: uv only moved across the edge (one axis) from the pixel
// centre — the bilinear filter is then a lerp of two texels on that axis.
vec4 SampleAcross( ivec2 p, vec4 centre, vec2 uv, bool horizontalEdge ) {
	float st = ( horizontalEdge ? uv.y * texSizePx.y : uv.x * texSizePx.x ) - 0.5;
	float i = floor( st );
	float f = Weights( vec2( st - i ) ).x;
	ivec2 axis = horizontalEdge ? ivec2( 0, 1 ) : ivec2( 1, 0 );
	int k = int( i ) - ( horizontalEdge ? p.y : p.x );
	vec4 lo = k == 0 ? centre : OutputTexel( p + axis * k );
	vec4 hi = k == -1 ? centre : OutputTexel( p + axis * ( k + 1 ) );
	return mix( lo, hi, f );
}

struct LuminanceData {
	float m, n, e, s, w;
	float ne, nw, se, sw;
	float highest, lowest, contrast;
};

float DeterminePixelBlendFactor( LuminanceData l ) {
	float f = 2.0 * ( l.n + l.e + l.s + l.w );
	f += l.ne + l.nw + l.se + l.sw;
	f *= 1.0 / 12.0;
	f = abs( f - l.m );
	f = clamp( f / l.contrast, 0.0, 1.0 );
	float blendFactor = smoothstep( 0.0, 1.0, f );
	return blendFactor * blendFactor * _SubpixelBlending;
}

struct EdgeData {
	bool isHorizontal;
	float pixelStep;
	float oppositeLuminance, gradient;
};

EdgeData DetermineEdge( vec2 texSize, LuminanceData l ) {
	EdgeData e;
	float horizontal =
		abs( l.n + l.s - 2.0 * l.m ) * 2.0 +
		abs( l.ne + l.se - 2.0 * l.e ) +
		abs( l.nw + l.sw - 2.0 * l.w );
	float vertical =
		abs( l.e + l.w - 2.0 * l.m ) * 2.0 +
		abs( l.ne + l.nw - 2.0 * l.n ) +
		abs( l.se + l.sw - 2.0 * l.s );
	e.isHorizontal = horizontal >= vertical;

	float pLuminance = e.isHorizontal ? l.n : l.e;
	float nLuminance = e.isHorizontal ? l.s : l.w;
	float pGradient = abs( pLuminance - l.m );
	float nGradient = abs( nLuminance - l.m );

	e.pixelStep = e.isHorizontal ? texSize.y : texSize.x;

	if ( pGradient < nGradient ) {
		e.pixelStep = -e.pixelStep;
		e.oppositeLuminance = nLuminance;
		e.gradient = nGradient;
	} else {
		e.oppositeLuminance = pLuminance;
		e.gradient = pGradient;
	}
	return e;
}

float DetermineEdgeBlendFactor( vec2 texSize, LuminanceData l, EdgeData e, vec2 uv ) {
	vec2 uvEdge = uv;
	vec2 edgeStep;
	if ( e.isHorizontal ) {
		uvEdge.y += e.pixelStep * 0.5;
		edgeStep = vec2( texSize.x, 0.0 );
	} else {
		uvEdge.x += e.pixelStep * 0.5;
		edgeStep = vec2( 0.0, texSize.y );
	}

	float edgeLuminance = ( l.m + e.oppositeLuminance ) * 0.5;
	float gradientThreshold = e.gradient * 0.25;

	vec2 puv = uvEdge + edgeStep * edgeSteps[0];
	float pLuminanceDelta = LumaBilinear( puv ) - edgeLuminance;
	bool pAtEnd = abs( pLuminanceDelta ) >= gradientThreshold;

	for ( int i = 1; i < EDGE_STEP_COUNT && !pAtEnd; i++ ) {
		puv += edgeStep * edgeSteps[i];
		pLuminanceDelta = LumaBilinear( puv ) - edgeLuminance;
		pAtEnd = abs( pLuminanceDelta ) >= gradientThreshold;
	}
	if ( !pAtEnd ) {
		puv += edgeStep * EDGE_GUESS;
	}

	vec2 nuv = uvEdge - edgeStep * edgeSteps[0];
	float nLuminanceDelta = LumaBilinear( nuv ) - edgeLuminance;
	bool nAtEnd = abs( nLuminanceDelta ) >= gradientThreshold;

	for ( int i = 1; i < EDGE_STEP_COUNT && !nAtEnd; i++ ) {
		nuv -= edgeStep * edgeSteps[i];
		nLuminanceDelta = LumaBilinear( nuv ) - edgeLuminance;
		nAtEnd = abs( nLuminanceDelta ) >= gradientThreshold;
	}
	if ( !nAtEnd ) {
		nuv -= edgeStep * EDGE_GUESS;
	}

	float pDistance, nDistance;
	if ( e.isHorizontal ) {
		pDistance = puv.x - uv.x;
		nDistance = uv.x - nuv.x;
	} else {
		pDistance = puv.y - uv.y;
		nDistance = uv.y - nuv.y;
	}

	float shortestDistance;
	bool deltaSign;
	if ( pDistance <= nDistance ) {
		shortestDistance = pDistance;
		deltaSign = pLuminanceDelta >= 0.0;
	} else {
		shortestDistance = nDistance;
		deltaSign = nLuminanceDelta >= 0.0;
	}

	if ( deltaSign == ( l.m - edgeLuminance >= 0.0 ) ) {
		return 0.0;
	}
	return 0.5 - shortestDistance / ( pDistance + nDistance );
}

void main() {
	ivec2 size = textureSize( tDiffuse, 0 );
	texSizePx = vec2( size );
	texMax = size - 1;
	vec2 texSize = resolution.xy;
	vec2 uv = vUv;
	// The pixel's own texel (the target has the canvas's size; vUv is the
	// pixel centre — what the old texture( vUv ) read).
	ivec2 p = ivec2( floor( uv * texSizePx ) );

	// The 3 × 3 neighbourhood sits on texel centres: plain texel reads. The
	// skip test only needs the cross; the corners are read for edge pixels.
	LuminanceData l;
	vec4 centre = OutputTexel( p );
	l.m = dot( centre.rgb, LUMA );
	l.n = LumaAt( p + ivec2( 0, 1 ) );
	l.e = LumaAt( p + ivec2( 1, 0 ) );
	l.s = LumaAt( p + ivec2( 0, -1 ) );
	l.w = LumaAt( p + ivec2( -1, 0 ) );
	l.highest = max( max( max( max( l.n, l.e ), l.s ), l.w ), l.m );
	l.lowest = min( min( min( min( l.n, l.e ), l.s ), l.w ), l.m );
	l.contrast = l.highest - l.lowest;

	float threshold = max( _ContrastThreshold, _RelativeThreshold * l.highest );
	if ( l.contrast < threshold ) {
		gl_FragColor = centre;
		return;
	}

	l.ne = LumaAt( p + ivec2( 1, 1 ) );
	l.nw = LumaAt( p + ivec2( -1, 1 ) );
	l.se = LumaAt( p + ivec2( 1, -1 ) );
	l.sw = LumaAt( p + ivec2( -1, -1 ) );

	float pixelBlend = DeterminePixelBlendFactor( l );
	EdgeData edge = DetermineEdge( texSize, l );
	float edgeBlend = DetermineEdgeBlendFactor( texSize, l, edge, uv );
	float finalBlend = max( pixelBlend, edgeBlend );

	if ( edge.isHorizontal ) {
		uv.y += edge.pixelStep * finalBlend;
	} else {
		uv.x += edge.pixelStep * finalBlend;
	}
	gl_FragColor = SampleAcross( p, centre, uv, edge.isHorizontal );
}
`;

export class OutputFXAAPass extends ShaderPass {
  constructor(subtexelBits: number | null = null) {
    super({
      name: "OutputFXAAShader",
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(1 / 1024, 1 / 512) },
      },
      defines: subtexelBits === null ? {} : { SUBTEXEL_BITS: subtexelBits },
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: OUTPUT_FXAA_FRAGMENT,
    });
  }

  /** Same contract as FXAAPass.setSize (drawing-buffer pixels). */
  override setSize(width: number, height: number): void {
    (this.material.uniforms.resolution.value as THREE.Vector2).set(1 / width, 1 / height);
  }
}
