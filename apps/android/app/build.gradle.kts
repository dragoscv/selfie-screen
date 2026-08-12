import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Local, gitignored secrets so the Azure key never touches source control.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "ro.codai.selfiescreen"
    compileSdk = 35

    defaultConfig {
        applicationId = "ro.codai.selfiescreen"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "AZURE_ENDPOINT",
            "\"${localProps.getProperty("azure.endpoint", "codai-foundry2.openai.azure.com")}\"")
        buildConfigField("String", "AZURE_KEY",
            "\"${localProps.getProperty("azure.key", "")}\"")
        buildConfigField("String", "AZURE_TTS_DEPLOYMENT",
            "\"${localProps.getProperty("azure.tts", "selfie-tts")}\"")
        buildConfigField("String", "AZURE_AI_DEPLOYMENT",
            "\"${localProps.getProperty("azure.ai", "selfie-ai")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation(platform("androidx.compose:compose-bom:2025.03.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // CameraX for direct rear-camera mode
    val camerax = "1.4.1"
    implementation("androidx.camera:camera-core:$camerax")
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")

    // USB CDC/CH340 serial
    implementation("com.github.mik3y:usb-serial-for-android:3.8.1")
    implementation("androidx.webkit:webkit:1.13.0")

    // Realtime voice: OkHttp WebSocket + kotlinx.serialization
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")

    // Persistence: memory across lives + settings
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("androidx.datastore:datastore-preferences:1.1.2")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
