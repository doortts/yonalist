use crate::{
    AccessDecision, PackBytes, PackLimits, PackRequest, Plane, ProjectId, RefAdvertisement,
    SyncError,
};
use crate::{DeviceId, GrantId, MemberId};

#[derive(Clone, Debug)]
pub struct Hello {
    pub project_id: ProjectId,
    pub member_id: MemberId,
    pub device_id: DeviceId,
    pub grant_id: GrantId,
}
#[derive(Debug)]
pub struct HelloAck {
    pub decision: AccessDecision,
}

pub trait PeerEndpoint {
    fn hello(&mut self, hello: &Hello) -> Result<HelloAck, SyncError>;
    fn advertise(
        &mut self,
        project: ProjectId,
        plane: Plane,
    ) -> Result<RefAdvertisement, SyncError>;
    fn create_pack(
        &mut self,
        project: ProjectId,
        request: &PackRequest,
        limits: &PackLimits,
    ) -> Result<PackBytes, SyncError>;
}
