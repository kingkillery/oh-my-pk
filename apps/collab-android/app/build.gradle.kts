plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "computer.pkking.ompk"
    compileSdk = 37

    defaultConfig {
        applicationId = "computer.pkking.ompk"
        minSdk = 35
        targetSdk = 37
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE",
                "META-INF/LICENSE.txt",
                "META-INF/LICENSE.md",
                "META-INF/NOTICE",
                "META-INF/NOTICE.txt",
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
            )
        }
    }

    lint {
        abortOnError = true
    }
}

dependencies {
    implementation(project(":link"))
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.core:core-splashscreen:1.2.0")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.camera:camera-core:1.6.2")
    implementation("androidx.camera:camera-camera2:1.6.2")
    implementation("androidx.camera:camera-lifecycle:1.6.2")
    implementation("androidx.camera:camera-view:1.6.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("androidx.security:security-crypto:1.1.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalFile

val buildCollabWeb = tasks.register<Exec>("buildCollabWeb") {
    workingDir = repoRoot
    commandLine("bun", "--cwd=packages/collab-web", "run", "build")
    outputs.dir(repoRoot.resolve("packages/collab-web/dist"))
    outputs.upToDateWhen { false }
}

abstract class StageCollabAssets : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val source: DirectoryProperty

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @TaskAction
    fun stage() {
        val dest = output.get().asFile
        if (dest.exists()) dest.deleteRecursively()
        source.get().asFile.copyRecursively(dest)
    }
}

androidComponents {
    onVariants { variant ->
        val capitalized = variant.name.replaceFirstChar { it.uppercase() }
        val stage = tasks.register<StageCollabAssets>("stage${capitalized}CollabAssets") {
            dependsOn(buildCollabWeb)
            source.set(repoRoot.resolve("packages/collab-web/dist"))
        }
        variant.sources.assets?.addGeneratedSourceDirectory(stage) { it.output }
    }
}
