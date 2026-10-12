import type { EncoderOptions, EncoderOptionsBuilderParams, PluginSettingsManager, PluginTranscodingManager, RegisterServerOptions, SettingValue } from "@peertube/peertube-types"
import type { Logger } from 'winston'

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
const DEFAULT_QUALITY : number = -1
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
    quality: number
    vaapiDevice: string
    cudaDevice: string
    baseBitrate: Map<number, number>
}
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
    qualityOptions(quality: number): string[]
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
    scaleFilter: hardwareDecode => hardwareDecode
        ? 'scale_vaapi'
        : 'format=nv12,hwupload,scale_vaapi',
    qualityOptions: quality => [`-quality ${quality}`],
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
    // hardware decode keeps the source pixel format (e.g. 10 bits), h264_nvenc cannot encode 10 bits
    scaleFilter: hardwareDecode => hardwareDecode
        ? 'scale_cuda=format=nv12,scale_cuda'
        : 'format=nv12,hwupload_cuda,scale_cuda',
    // plugin quality: 1 = best/slowest to 7 = fastest, nvenc presets: p1 = fastest to p7 = best/slowest
    qualityOptions: quality => [`-preset p${quality < 1 || quality > 7 ? 4 : 8 - quality}`],
    outputOptions: (streamSuffix, targetBitrate) => [
        // PeerTube forces -pix_fmt yuv420p, which h264_nvenc accepts, so ffmpeg would try to
        // convert the GPU frames back to system memory and fail. Keep the frames on the GPU.
        `-pix_fmt:v${streamSuffix} cuda`,
        `-rc:v${streamSuffix} vbr`,
        `-b:v${streamSuffix} ${targetBitrate}`,
        `-maxrate:v${streamSuffix} ${targetBitrate}`,
        `-bufsize ${targetBitrate * 2}`
    ],
    // let nvenc pick the level, 3.1 is too low for resolutions above 720p30
    liveOutputOptions: streamSuffix => [
        `-profile:v${streamSuffix} high`
    ]
}

const BACKENDS : Backend[] = [vaapi, nvenc]

let latestStreamNum = 9999

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

        descriptionHTML: 'Use hardware video decoder instead of software decoder. This will slightly improve performance but may cause some issues with some videos. If you encounter issues, disable this option and restart failed jobs.',

        default: DEFAULT_HARDWARE_DECODE,
        private: false
    })
    registerSetting({
        name: 'quality',
        label: 'Quality',

        type: 'select',
        options: [
            { label: 'Automatic', value: '-1' },
            { label: '1', value: '1' },
            { label: '2', value: '2' },
            { label: '3', value: '3' },
            { label: '4', value: '4' },
            { label: '5', value: '5' },
            { label: '6', value: '6' },
            { label: '7', value: '7' }
        ],

        descriptionHTML: 'This parameter controls the speed / quality tradeoff. Lower values mean better quality but slower encoding. Higher values mean faster encoding but lower quality.<br/>VAAPI: this setting is hardware dependent, you may need to experiment to find the best value for your hardware. Some hardware may have less than 7 levels of compression.<br/>NVENC: 1 to 7 map to presets p7 (slowest) to p1 (fastest), automatic uses p4.',

        default: DEFAULT_QUALITY.toString(),
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

async function loadSettings(settingsManager: PluginSettingsManager) {
    pluginSettings.hardwareDecode = isTrue(await settingsManager.getSetting('hardware-decode'))
    pluginSettings.quality = parseInt(await settingsManager.getSetting('quality') as string) || DEFAULT_QUALITY
    pluginSettings.vaapiDevice = stringSetting(await settingsManager.getSetting('vaapi-device'), DEFAULT_VAAPI_DEVICE)
    pluginSettings.cudaDevice = stringSetting(await settingsManager.getSetting('cuda-device'), DEFAULT_CUDA_DEVICE)

    for (const [resolution, bitrate] of DEFAULT_BITRATES) {
        const key = `base-bitrate-${resolution}`
        const storedValue = await settingsManager.getSetting(key) as string
        pluginSettings.baseBitrate.set(resolution, parseInt(storedValue) || bitrate)
        logger.info(`Bitrate ${printResolution(resolution)}: ${pluginSettings.baseBitrate.get(resolution)}`)
    }

    logger.info(`Hardware decode: ${pluginSettings.hardwareDecode}`)
    logger.info(`Quality: ${pluginSettings.quality}`)
    logger.info(`VAAPI device: ${pluginSettings.vaapiDevice}`)
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

async function vodBuilder(backend : Backend, params: EncoderOptionsBuilderParams) : Promise<EncoderOptions> {
    const { resolution, fps, streamNum, inputBitrate } = params
    const streamSuffix = streamNum == undefined ? '' : `:${streamNum}`
    const targetBitrate = Math.min(getTargetBitrate(resolution, fps), inputBitrate)

    logger.info(`Building ${backend.profile} encoder options, received ${JSON.stringify(params, ignoreProbe)}`)

    let options : EncoderOptions = {
        scaleFilter: {
            name: backend.scaleFilter(pluginSettings.hardwareDecode)
        },
        inputOptions: shouldInitHardware(streamNum) ? backend.initOptions(pluginSettings.hardwareDecode) : [],
        outputOptions: [
            ...backend.qualityOptions(pluginSettings.quality),
            ...backend.outputOptions(streamSuffix, targetBitrate)
        ]
    }
    logger.info(`EncoderOptions: ${JSON.stringify(options)}`)
    return options
}


async function liveBuilder(backend : Backend, params: EncoderOptionsBuilderParams) : Promise<EncoderOptions> {
    const { resolution, fps, streamNum, inputBitrate } = params
    const streamSuffix = streamNum == undefined ? '' : `:${streamNum}`
    const targetBitrate = Math.min(getTargetBitrate(resolution, fps), inputBitrate)

    logger.info(`Building ${backend.profile} live encoder options, received ${JSON.stringify(params, ignoreProbe)}`)

    const options : EncoderOptions = {
        scaleFilter: {
            name: backend.scaleFilter(pluginSettings.hardwareDecode)
        },
        inputOptions: shouldInitHardware(streamNum) ? backend.initOptions(pluginSettings.hardwareDecode) : [],
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
