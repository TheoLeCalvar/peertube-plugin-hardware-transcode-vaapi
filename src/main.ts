import type { EncoderOptions, EncoderOptionsBuilderParams, PluginSettingsManager, PluginTranscodingManager, RegisterServerOptions, SettingValue } from "@peertube/peertube-types"
import type { Logger } from 'winston'
import { readFile } from 'fs/promises'
import { basename } from 'path'
import { spawn } from 'child_process'

// @peertube/peertube-types only ships type declarations, values must be defined here
const VideoResolution = {
    H_NOVIDEO: 0,
    H_144P: 144,
    H_240P: 240,
    H_360P: 360,
    H_480P: 480,
    H_720P: 720,
    H_1080P: 1080,
    H_1440P: 1440,
    H_4K: 2160
} as const

let logger : Logger
let transcodingManager : PluginTranscodingManager

const DEFAULT_HARDWARE_DECODE : boolean = false
/**
 * Encoder speed / quality tradeoff. Each backend (and VAAPI driver) translates it to its own scale,
 * 'driver-default' sends nothing and lets the encoder pick.
 */
type QualityPreset = 'quality' | 'balanced' | 'speed' | 'driver-default'
const QUALITY_PRESETS : QualityPreset[] = ['quality', 'balanced', 'speed', 'driver-default']
const DEFAULT_QUALITY : QualityPreset = 'balanced'
const DEFAULT_VAAPI_DEVICE : string = '/dev/dri/renderD128'
const DEFAULT_CUDA_DEVICE : string = '0'
const DEFAULT_BITRATES : Map<number, number> = new Map([
    [VideoResolution.H_NOVIDEO, 64 * 1000],
    [VideoResolution.H_144P, 320 * 1000],
    [VideoResolution.H_240P, 500 * 1000],
    [VideoResolution.H_360P, 780 * 1000],
    [VideoResolution.H_480P, 1500 * 1000],
    [VideoResolution.H_720P, 2800 * 1000],
    [VideoResolution.H_1080P, 5200 * 1000],
    [VideoResolution.H_1440P, 10_000 * 1000],
    [VideoResolution.H_4K, 22_000 * 1000]
])

interface PluginSettings {
    hardwareDecode : boolean
    quality: QualityPreset
    vaapiDevice: string
    cudaDevice: string
    baseBitrate: Map<number, number>
}
// PCI vendor IDs of the GPUs supported by the vaapi profile
const VENDOR_INTEL = '0x8086'
const VENDOR_AMD = '0x1002'
// vendor of the GPU behind the VAAPI device, used to pick the quality scale of its driver
let vaapiVendor : string | undefined

let pluginSettings : PluginSettings = {
    hardwareDecode: DEFAULT_HARDWARE_DECODE,
    quality: DEFAULT_QUALITY,
    vaapiDevice: DEFAULT_VAAPI_DEVICE,
    cudaDevice: DEFAULT_CUDA_DEVICE,
    baseBitrate: new Map(DEFAULT_BITRATES)
}

/**
 * Everything that differs between hardware backends.
 * Each backend is registered as its own transcoding profile, the admin selects
 * it in Administration > Configuration > VOD/Live Transcoding.
 */
interface Backend {
    encoder: string
    profile: string
    initOptions(hardwareDecode: boolean): string[]
    // PeerTube appends `=w=...:h=...` to this name
    scaleFilter(hardwareDecode: boolean): string
    qualityOptions(quality: QualityPreset): string[]
    outputOptions(streamSuffix: string, targetBitrate: number): string[]
    liveOutputOptions(streamSuffix: string): string[]
}

const vaapi : Backend = {
    encoder: 'h264_vaapi',
    profile: 'vaapi',
    initOptions: hardwareDecode => hardwareDecode
        ? [
            '-hwaccel vaapi',
            `-vaapi_device ${pluginSettings.vaapiDevice}`,
            '-hwaccel_output_format vaapi',
        ]
        : [`-vaapi_device ${pluginSettings.vaapiDevice}`],
    // software decode requires specifying pixel format for hardware filter and upload it to GPU
    // hardware decode keeps the source pixel format (e.g. 10 bits), convert it to nv12 for h264
    scaleFilter: hardwareDecode => hardwareDecode
        ? 'scale_vaapi=format=nv12,scale_vaapi'
        : 'format=nv12,hwupload,scale_vaapi',
    // -quality is passed as is to the driver (VAEncMiscParameterBufferQualityLevel), each driver has its own scale
    qualityOptions: quality => {
        const level = vaapiQualityLevel(quality)
        return level == undefined ? [] : [`-quality ${level}`]
    },
    outputOptions: (streamSuffix, targetBitrate) => [
        `-b:v${streamSuffix} ${targetBitrate}`,
        `-bufsize ${targetBitrate * 2}`
    ],
    liveOutputOptions: streamSuffix => [
        `-profile:v${streamSuffix} high`,
        `-level:v${streamSuffix} 3.1`
    ]
}

const nvenc : Backend = {
    encoder: 'h264_nvenc',
    profile: 'nvenc',
    initOptions: hardwareDecode => hardwareDecode
        ? [
            `-hwaccel cuda`,
            `-hwaccel_device ${pluginSettings.cudaDevice}`,
            '-hwaccel_output_format cuda',
        ]
        : [
            `-init_hw_device cuda=cu:${pluginSettings.cudaDevice}`,
            '-filter_hw_device cu',
        ],
    // same as vaapi, h264_nvenc cannot encode 10 bits
    scaleFilter: hardwareDecode => hardwareDecode
        ? 'scale_cuda=format=nv12,scale_cuda'
        : 'format=nv12,hwupload_cuda,scale_cuda',
    // nvenc presets: p1 = fastest to p7 = best/slowest, ffmpeg default is p4
    qualityOptions: quality => {
        switch (quality) {
            case 'quality': return ['-preset p7']
            case 'balanced': return ['-preset p4']
            case 'speed': return ['-preset p1']
            default: return []
        }
    },
    outputOptions: (streamSuffix, targetBitrate) => [
        // PeerTube forces -pix_fmt yuv420p, which h264_nvenc accepts, so ffmpeg would try to
        // convert the GPU frames back to system memory and fail. Keep the frames on the GPU.
        `-pix_fmt:v${streamSuffix} cuda`,
        // ffmpeg < 8 defaults to main
        `-profile:v${streamSuffix} high`,
        `-rc:v${streamSuffix} vbr`,
        `-b:v${streamSuffix} ${targetBitrate}`,
        `-maxrate:v${streamSuffix} ${targetBitrate}`,
        `-bufsize ${targetBitrate * 2}`
    ],
    // let nvenc pick the level, 3.1 is too low for resolutions above 720p30
    liveOutputOptions: () => []
}

const BACKENDS : Backend[] = [vaapi, nvenc]

/**
 * Translate the quality preset to the VAAPI driver's quality level, undefined to use the driver default.
 */
function vaapiQualityLevel(quality : QualityPreset) : number | undefined {
    if (quality === 'driver-default') return undefined

    switch (vaapiVendor) {
        // Intel (iHD and i965): target usage, 1 = best quality to 7 = fastest, default 4.
        // i965 on GPUs older than Skylake only has 1 and 2, ffmpeg clamps higher values to 2.
        case VENDOR_INTEL:
            return { quality: 1, balanced: 4, speed: 7 }[quality]
        // AMD (Mesa): the level is a bitfield. Bit 0: valid, bits 1-2: preset (0 speed, 1 balanced, 2 quality,
        // 3 high quality, VCN 4+ only, quality on older GPUs), bit 3: pre-encode, bit 4: VBAQ.
        // 1 is special and means balanced + pre-encode + VBAQ, 0 means speed. Sending nothing also gives speed.
        case VENDOR_AMD:
            return { quality: 0b11111, balanced: 1, speed: 0 }[quality]
        default:
            return undefined
    }
}

/**
 * Read the PCI vendor of the GPU behind a DRM render node, e.g. /dev/dri/renderD128.
 */
async function readDrmVendor(device : string) : Promise<string | undefined> {
    try {
        return (await readFile(`/sys/class/drm/${basename(device)}/device/vendor`, 'utf8')).trim()
    } catch {
        return undefined
    }
}

let latestStreamNum = 9999

// Hardware decode support per backend and input format, filled by testing each format on first use
const hardwareDecodeSupport : Map<string, Promise<boolean>> = new Map()
const HARDWARE_DECODE_TEST_TIMEOUT = 30_000

export async function register({settingsManager, peertubeHelpers, transcodingManager: transcode, registerSetting} :RegisterServerOptions) {
    logger = peertubeHelpers.logger
    transcodingManager = transcode

    logger.info("Registering peertube-plugin-hardware-encode");

    // Add transcoding profiles. Do not register a 'default' profile: PeerTube tries encoders by priority
    // and falls back to their default profile, so the other backend's encoder would be picked.
    for (const backend of BACKENDS) {
        transcodingManager.addVODProfile(backend.encoder, backend.profile, params => vodBuilder(backend, params))
        transcodingManager.addVODEncoderPriority('video', backend.encoder, 1000)

        transcodingManager.addLiveProfile(backend.encoder, backend.profile, params => liveBuilder(backend, params))
        transcodingManager.addLiveEncoderPriority('video', backend.encoder, 1000)
    }

    // Load existing settings and default to constants if not present
    await loadSettings(settingsManager)

    registerSetting({
        name: 'backend-description',
        label: 'Backend',

        type: 'html',
        html: '',
        descriptionHTML: `This plugin adds two transcoding profiles: <code>vaapi</code> (Intel and AMD GPUs) and <code>nvenc</code> (NVIDIA GPUs). Select the one matching your GPU in <i>Administration &gt; Configuration &gt; VOD Transcoding</i> and <i>Live Transcoding</i>.`,

        private: true,
    })
    registerSetting({
        name: 'hardware-decode',
        label: 'Hardware decode',

        type: 'input-checkbox',

        descriptionHTML: 'Decode videos on the GPU instead of the CPU, which reduces CPU usage and speeds up transcoding.'
            + '<br/>The first time a video format (codec, profile, pixel format) is transcoded, the plugin checks whether the GPU can decode it, by decoding a few frames. Formats the GPU cannot decode (e.g. 10 bits H.264) use software decode. The result is logged and kept until the plugin settings change or PeerTube restarts.',

        default: DEFAULT_HARDWARE_DECODE,
        private: false
    })
    registerSetting({
        name: 'quality',
        label: 'Quality',

        type: 'select',
        options: [
            { label: 'Quality', value: 'quality' },
            { label: 'Balanced', value: 'balanced' },
            { label: 'Speed', value: 'speed' },
            { label: 'Driver default', value: 'driver-default' }
        ],

        descriptionHTML: 'Encoder speed / quality tradeoff. It does not change the bitrate (set below), only how well the encoder uses it: <i>Quality</i> gives a better picture at the same file size but encodes slower, <i>Speed</i> is the fastest.'
            + '<br/>The plugin translates it to the scale of your GPU: Intel target usage 1 / 4 / 7, AMD high quality / balanced / speed presets, NVIDIA presets p7 / p4 / p1. <i>Driver default</i> lets the driver choose (the speed preset on AMD).'
            + '<br/>On Intel GPUs older than Skylake, <i>Balanced</i> is the same as <i>Speed</i>.',

        default: DEFAULT_QUALITY,
        private: false
    })
    registerSetting({
        name: 'vaapi-device',
        label: 'VAAPI device',

        type: 'input',

        descriptionHTML: `VAAPI render node used by the <code>vaapi</code> profile. Default value: ${DEFAULT_VAAPI_DEVICE}`,

        default: DEFAULT_VAAPI_DEVICE,
        private: false
    })
    registerSetting({
        name: 'cuda-device',
        label: 'CUDA device',

        type: 'input',

        descriptionHTML: `Index of the NVIDIA GPU used by the <code>nvenc</code> profile, as listed by <code>nvidia-smi</code>. Default value: ${DEFAULT_CUDA_DEVICE}`,

        default: DEFAULT_CUDA_DEVICE,
        private: false
    })

    registerSetting({
        name: 'base-bitrate-description',
        label: 'Base bitrate',

        type: 'html',
        html: '',
        descriptionHTML: `The base bitrate for video in bits. We take the min bitrate between the bitrate setting and video bitrate.<br/>This is the bitrate used when the video is transcoded at 30 FPS. The bitrate will be scaled linearly between this value and the maximum bitrate when the video is transcoded at 60 FPS. Wrong values are replaced by default values.`,

        private: true,
    })
    for (const [resolution, bitrate] of pluginSettings.baseBitrate) {
        logger.info("registering bitrate setting: "+ bitrate.toString())
        registerSetting({
            name: `base-bitrate-${resolution}`,
            label: `Base bitrate for ${printResolution(resolution)}`,

            type: 'input',

            default: DEFAULT_BITRATES.get(resolution)?.toString(),
            descriptionHTML: `Default value: ${DEFAULT_BITRATES.get(resolution)}`,

            private: false
        })
    }

    settingsManager.onSettingsChange(async () => {
        await loadSettings(settingsManager)
    })
}

export async function unregister() {
    logger.info("Unregistering peertube-plugin-hardware-encode")
    transcodingManager.removeAllProfilesAndEncoderPriorities()
    return true
}

// Checkbox values are stored as booleans, older versions of the plugin stored strings
function isTrue(value : SettingValue | undefined) : boolean {
    return value === true || value === 'true'
}

function stringSetting(value : SettingValue | undefined, defaultValue : string) : string {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : defaultValue
}

// Versions up to 0.3.0 stored the VAAPI quality level of Intel GPUs: -1 (automatic) or 1 (best) to 7 (fastest).
// Automatic becomes balanced: same as the Intel and NVIDIA defaults, and better than the AMD one (speed).
function qualitySetting(value : SettingValue | undefined) : QualityPreset {
    if (QUALITY_PRESETS.includes(value as QualityPreset)) return value as QualityPreset

    const level = parseInt(value as string)
    if (level >= 1 && level <= 2) return 'quality'
    if (level >= 6 && level <= 7) return 'speed'
    return DEFAULT_QUALITY
}

async function loadSettings(settingsManager: PluginSettingsManager) {
    pluginSettings.hardwareDecode = isTrue(await settingsManager.getSetting('hardware-decode'))
    const storedQuality = await settingsManager.getSetting('quality')
    pluginSettings.quality = qualitySetting(storedQuality)
    // store converted values of older versions, otherwise the select is blank in the settings page
    if (storedQuality != undefined && storedQuality !== pluginSettings.quality) {
        logger.info(`Converting quality setting ${storedQuality} to ${pluginSettings.quality}`)
        await settingsManager.setSetting('quality', pluginSettings.quality)
    }
    pluginSettings.vaapiDevice = stringSetting(await settingsManager.getSetting('vaapi-device'), DEFAULT_VAAPI_DEVICE)
    pluginSettings.cudaDevice = stringSetting(await settingsManager.getSetting('cuda-device'), DEFAULT_CUDA_DEVICE)
    vaapiVendor = await readDrmVendor(pluginSettings.vaapiDevice)
    // devices may have changed
    hardwareDecodeSupport.clear()

    for (const [resolution, bitrate] of DEFAULT_BITRATES) {
        const key = `base-bitrate-${resolution}`
        const storedValue = await settingsManager.getSetting(key) as string
        pluginSettings.baseBitrate.set(resolution, parseInt(storedValue) || bitrate)
        logger.info(`Bitrate ${printResolution(resolution)}: ${pluginSettings.baseBitrate.get(resolution)}`)
    }

    logger.info(`Hardware decode: ${pluginSettings.hardwareDecode}`)
    logger.info(`Quality: ${pluginSettings.quality}`)
    logger.info(`VAAPI device: ${pluginSettings.vaapiDevice} (vendor ${vaapiVendor ?? 'unknown'})`)
    if (vaapiVendor !== VENDOR_INTEL && vaapiVendor !== VENDOR_AMD) {
        // not an error for NVENC users, the vaapi profile is not used
        logger.info(`Unknown vendor for VAAPI device ${pluginSettings.vaapiDevice}, the vaapi profile uses the driver default quality`)
    }
    logger.info(`CUDA device: ${pluginSettings.cudaDevice}`)
}

function printResolution(resolution : number) : string {
    switch (resolution) {
        case VideoResolution.H_NOVIDEO: return 'audio only'
        case VideoResolution.H_144P:
        case VideoResolution.H_240P:
        case VideoResolution.H_360P:
        case VideoResolution.H_480P:
        case VideoResolution.H_720P:
        case VideoResolution.H_1080P:
        case VideoResolution.H_1440P:
            return `${resolution}p`
        case VideoResolution.H_4K: return '4K'

        default: return 'Unknown'
    }
}

/**
 * Hardware init options must only be added once per ffmpeg command. Live transcoding calls the
 * builder once per output stream, with increasing streamNum: only the first one gets them.
 */
function shouldInitHardware(streamNum : number | undefined) : boolean {
    const shouldInit = (streamNum == undefined || streamNum <= latestStreamNum)

    if (shouldInit && streamNum != undefined) {
        latestStreamNum = streamNum
    }
    return shouldInit
}

/**
 * Whether the input can be decoded by the GPU. When hardware decode is enabled, each input format
 * (codec, profile, pixel format, size) is tested once per backend by decoding a few frames of the
 * input with the hardware decode pipeline. Unsupported formats fall back to software decode.
 */
async function useHardwareDecode(backend : Backend, input : string, inputProbe : EncoderOptionsBuilderParams['inputProbe']) : Promise<boolean> {
    if (!pluginSettings.hardwareDecode) return false

    const video = inputProbe?.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
    // no probe (PeerTube < 6): test this input only
    const format = video
        ? `${video.codec_name} ${video.profile} ${video.pix_fmt}${Math.max(video.width ?? 0, video.height ?? 0) > 4096 ? ' >4K' : ''}`
        : input
    const key = `${backend.profile} ${format}`

    let supported = hardwareDecodeSupport.get(key)
    if (supported == undefined) {
        supported = testHardwareDecode(backend, input, video?.index).then(result => {
            if (result == undefined) {
                logger.warn(`Hardware decode test of ${format} with ${backend.profile} timed out, using software decode`)
            } else {
                logger.info(`Hardware decode of ${format} with ${backend.profile}: ${result ? 'supported' : 'not supported, using software decode'}`)
            }
            // inconclusive results and inputs without probe are tested again next time
            if (result == undefined || !video) hardwareDecodeSupport.delete(key)
            return result ?? false
        })
        hardwareDecodeSupport.set(key, supported)
    }
    return supported
}

/**
 * Decode and scale a few frames of the input with the hardware decode pipeline. When the GPU cannot decode the
 * input, ffmpeg silently falls back to software decode and the hardware scale filter fails on the software frames.
 * Resolves to undefined on timeout.
 */
function testHardwareDecode(backend : Backend, input : string, streamIndex : number | undefined) : Promise<boolean | undefined> {
    const args = [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        ...backend.initOptions(true).flatMap(option => option.split(' ')),
        '-i', input,
        '-map', streamIndex == undefined ? '0:v:0' : `0:${streamIndex}`,
        '-frames:v', '2',
        '-vf', `${backend.scaleFilter(true)}=w=-2:h=144`,
        '-f', 'null', '-'
    ]

    return new Promise(resolve => {
        let stderr = ''
        const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: [ 'ignore', 'ignore', 'pipe' ] })
        const timeout = setTimeout(() => ffmpeg.kill('SIGKILL'), HARDWARE_DECODE_TEST_TIMEOUT)

        ffmpeg.stderr.on('data', data => stderr += data)
        ffmpeg.on('error', err => {
            clearTimeout(timeout)
            logger.warn(`Cannot run ffmpeg to test hardware decode: ${err.message}`)
            resolve(false)
        })
        ffmpeg.on('close', code => {
            clearTimeout(timeout)
            if (code !== 0) logger.debug(`Hardware decode test failed (${code ?? 'timeout'}): ${stderr.trim()}`)
            resolve(code == null ? undefined : code === 0)
        })
    })
}

async function vodBuilder(backend : Backend, params: EncoderOptionsBuilderParams) : Promise<EncoderOptions> {
    const { input, inputProbe, resolution, fps, streamNum, inputBitrate } = params
    const streamSuffix = streamNum == undefined ? '' : `:${streamNum}`
    const targetBitrate = Math.min(getTargetBitrate(resolution, fps), inputBitrate)
    const hardwareDecode = await useHardwareDecode(backend, input, inputProbe)

    logger.info(`Building ${backend.profile} encoder options, received ${JSON.stringify(params, ignoreProbe)}`)

    let options : EncoderOptions = {
        scaleFilter: {
            name: backend.scaleFilter(hardwareDecode)
        },
        inputOptions: shouldInitHardware(streamNum) ? backend.initOptions(hardwareDecode) : [],
        outputOptions: [
            ...backend.qualityOptions(pluginSettings.quality),
            ...backend.outputOptions(streamSuffix, targetBitrate)
        ]
    }
    logger.info(`EncoderOptions: ${JSON.stringify(options)}`)
    return options
}


async function liveBuilder(backend : Backend, params: EncoderOptionsBuilderParams) : Promise<EncoderOptions> {
    const { input, inputProbe, resolution, fps, streamNum, inputBitrate } = params
    const streamSuffix = streamNum == undefined ? '' : `:${streamNum}`
    const targetBitrate = Math.min(getTargetBitrate(resolution, fps), inputBitrate)
    const hardwareDecode = await useHardwareDecode(backend, input, inputProbe)

    logger.info(`Building ${backend.profile} live encoder options, received ${JSON.stringify(params, ignoreProbe)}`)

    const options : EncoderOptions = {
        scaleFilter: {
            name: backend.scaleFilter(hardwareDecode)
        },
        inputOptions: shouldInitHardware(streamNum) ? backend.initOptions(hardwareDecode) : [],
        outputOptions: [
            ...backend.qualityOptions(pluginSettings.quality),
            `-r:v${streamSuffix} ${fps}`,
            ...backend.liveOutputOptions(streamSuffix),
            `-g:v${streamSuffix} ${fps*2}`,
            ...backend.outputOptions(streamSuffix, targetBitrate)
        ]
    }
    logger.info(`EncoderOptions: ${JSON.stringify(options)}`)
    return options
}

// inputProbe (PeerTube >= 6) contains the whole ffprobe output, too verbose for the logs
function ignoreProbe(key : string, value : unknown) : unknown {
    return key === 'inputProbe' ? undefined : value
}

/**
 * Calculate the target bitrate based on video resolution and FPS.
 *
 * The calculation is based on two values:
 * Bitrate at VideoTranscodingFPS.AVERAGE is always the same as
 * getBaseBitrate(). Bitrate at VideoTranscodingFPS.MAX is always
 * getBaseBitrate() * 1.4. All other values are calculated linearly
 * between these two points.
 */
function getTargetBitrate (resolution : number, fps : number) : number {
    const baseBitrate = pluginSettings.baseBitrate.get(resolution) || 0
    // The maximum bitrate, used when fps === VideoTranscodingFPS.MAX
    // Based on numbers from Youtube, 60 fps bitrate divided by 30 fps bitrate:
    //  720p: 2600 / 1750 = 1.49
    // 1080p: 4400 / 3300 = 1.33
    const maxBitrate = baseBitrate * 1.4
    const maxBitrateDifference = maxBitrate - baseBitrate
    const maxFpsDifference = 60 - 30
    // For 1080p video with default settings, this results in the following formula:
    // 3300 + (x - 30) * (1320/30)
    // Example outputs:
    // 1080p10: 2420 kbps, 1080p30: 3300 kbps, 1080p60: 4620 kbps
    //  720p10: 1283 kbps,  720p30: 1750 kbps,  720p60: 2450 kbps
    return Math.floor(baseBitrate + (fps - 30) * (maxBitrateDifference / maxFpsDifference))
}
