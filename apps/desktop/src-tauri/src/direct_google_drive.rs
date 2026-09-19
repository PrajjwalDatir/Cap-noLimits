use std::path::PathBuf;
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;
use tracing::info;

use crate::UploadProgress;

#[derive(serde::Deserialize)]
struct DriveFileResponse {
    id: String,
    #[serde(rename = "webViewLink")]
    web_view_link: Option<String>,
}

#[tauri::command]
pub async fn upload_file_to_google_drive(
    file_path: PathBuf,
    access_token: String,
    folder_id: Option<String>,
    file_name: String,
    channel: Channel<UploadProgress>,
) -> Result<String, String> {
    if !file_path.exists() {
        return Err("Video file does not exist".to_string());
    }

    let file_metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| format!("Failed to read file metadata: {e}"))?;
    let total_size = file_metadata.len();

    let client = reqwest::Client::new();

    let mut body = serde_json::json!({
        "name": file_name,
    });
    if let Some(folder) = folder_id.filter(|f| !f.is_empty()) {
        body["parents"] = serde_json::json!([folder]);
    }

    let init_res = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink")
        .bearer_auth(&access_token)
        .header("Content-Type", "application/json; charset=UTF-8")
        .header("X-Upload-Content-Type", "video/mp4")
        .header("X-Upload-Content-Length", total_size.to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to initialize Google Drive upload: {e}"))?;

    if !init_res.status().is_success() {
        let status = init_res.status();
        let text = init_res.text().await.unwrap_or_default();
        return Err(format!(
            "Google Drive rejected upload initialization ({status}): {text}"
        ));
    }

    let upload_url = init_res
        .headers()
        .get("Location")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Google Drive did not return a resumable upload location".to_string())?
        .to_string();

    let mut file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| format!("Failed to open video file: {e}"))?;

    let chunk_size: usize = 8 * 1024 * 1024;
    let mut uploaded_bytes: u64 = 0;
    let mut buffer = vec![0u8; chunk_size];
    let mut final_response: Option<DriveFileResponse> = None;

    while uploaded_bytes < total_size {
        let remaining = (total_size - uploaded_bytes) as usize;
        let to_read = remaining.min(chunk_size);
        let bytes_read = file
            .read_exact(&mut buffer[..to_read])
            .await
            .map_err(|e| format!("Failed reading file chunk: {e}"))?;

        let start = uploaded_bytes;
        let end = uploaded_bytes + bytes_read as u64 - 1;
        let content_range = format!("bytes {start}-{end}/{total_size}");

        let chunk_data = buffer[..bytes_read].to_vec();
        let chunk_res = client
            .put(&upload_url)
            .header("Content-Length", bytes_read.to_string())
            .header("Content-Range", content_range)
            .body(chunk_data)
            .send()
            .await
            .map_err(|e| format!("Failed uploading chunk to Google Drive: {e}"))?;

        uploaded_bytes += bytes_read as u64;
        let progress = (uploaded_bytes as f64) / (total_size as f64);
        let _ = channel.send(UploadProgress { progress });

        if chunk_res.status().is_success() {
            final_response = chunk_res.json::<DriveFileResponse>().await.ok();
            break;
        } else if chunk_res.status().as_u16() == 308 {
            continue;
        } else {
            let status = chunk_res.status();
            let text = chunk_res.text().await.unwrap_or_default();
            return Err(format!("Chunk upload failed ({status}): {text}"));
        }
    }

    let file_info = final_response
        .ok_or_else(|| "Google Drive upload ended without file response".to_string())?;

    let permission_body = serde_json::json!({
        "role": "reader",
        "type": "anyone"
    });
    let _ = client
        .post(format!(
            "https://www.googleapis.com/drive/v3/files/{}/permissions",
            file_info.id
        ))
        .bearer_auth(&access_token)
        .json(&permission_body)
        .send()
        .await;

    let link = file_info.web_view_link.unwrap_or_else(|| {
        format!(
            "https://drive.google.com/file/d/{}/view?usp=sharing",
            file_info.id
        )
    });

    info!("Direct Google Drive upload succeeded: {link}");
    Ok(link)
}
